import { isDefined, parseSelectedColumns } from "./parse.js";
import {
  getAgentAuthSessionSelectColumnValue,
  getAgentRegistrationChallengeSelectColumnValue,
  getAgentSelectColumnValue,
  getApiKeySelectColumnValue,
  getCrlSelectColumnValue,
  getHumanSelectColumnValue,
  getInviteSelectColumnValue,
  resolveAgentAuthSessionSelectRows,
  resolveAgentRegistrationChallengeSelectRows,
  resolveAgentSelectRows,
  resolveApiKeySelectRows,
  resolveCrlSelectRows,
  resolveHumanSelectRows,
  resolveInviteSelectRows,
} from "./resolvers.js";
import { handleRunQuery } from "./run-handlers.js";
import type {
  FakeAgentAuthEventInsertRow,
  FakeAgentAuthSessionInsertRow,
  FakeAgentAuthSessionUpdateRow,
  FakeAgentInsertRow,
  FakeAgentRegistrationChallengeInsertRow,
  FakeAgentRegistrationChallengeUpdateRow,
  FakeAgentRow,
  FakeAgentUpdateRow,
  FakeApiKeyInsertRow,
  FakeApiKeyRow,
  FakeD1Row,
  FakeDbOptions,
  FakeDbState,
  FakeHumanInsertRow,
  FakeHumanRow,
  FakeInviteInsertRow,
  FakeInviteUpdateRow,
  FakeRevocationInsertRow,
} from "./types.js";

export function createFakeDb(
  rows: FakeD1Row[],
  agentRows: FakeAgentRow[] = [],
  options: FakeDbOptions = {},
) {
  const updates: Array<{ lastUsedAt: string; apiKeyId: string }> = [];
  const humanInserts: FakeHumanInsertRow[] = [];
  const apiKeyInserts: FakeApiKeyInsertRow[] = [];
  const agentInserts: FakeAgentInsertRow[] = [];
  const agentUpdates: FakeAgentUpdateRow[] = [];
  const revocationInserts: FakeRevocationInsertRow[] = [];
  const agentRegistrationChallengeInserts: FakeAgentRegistrationChallengeInsertRow[] =
    [];
  const agentRegistrationChallengeUpdates: FakeAgentRegistrationChallengeUpdateRow[] =
    [];
  const agentAuthSessionInserts: FakeAgentAuthSessionInsertRow[] = [];
  const agentAuthSessionUpdates: FakeAgentAuthSessionUpdateRow[] = [];
  const agentAuthEventInserts: FakeAgentAuthEventInsertRow[] = [];
  const inviteInserts: FakeInviteInsertRow[] = [];
  const inviteUpdates: FakeInviteUpdateRow[] = [];
  const revocationRows = [...(options.revocationRows ?? [])];
  const registrationChallengeRows = [
    ...(options.registrationChallengeRows ?? []),
  ];
  const agentAuthSessionRows = [...(options.agentAuthSessionRows ?? [])];
  const inviteRows = [...(options.inviteRows ?? [])];
  const humanRows = rows.reduce<FakeHumanRow[]>((acc, row) => {
    if (acc.some((item) => item.id === row.humanId)) {
      return acc;
    }

    acc.push({
      id: row.humanId,
      did: row.humanDid,
      displayName: row.humanDisplayName,
      role: row.humanRole,
      status: row.humanStatus,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return acc;
  }, []);
  const apiKeyRows: FakeApiKeyRow[] = rows.map((row) => ({
    id: row.apiKeyId,
    humanId: row.humanId,
    keyHash: row.keyHash,
    keyPrefix: row.keyPrefix,
    name: row.apiKeyName,
    status: row.apiKeyStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
  }));
  const state: FakeDbState = {
    authRows: rows,
    agentRows,
    options,
    updates,
    humanInserts,
    apiKeyInserts,
    agentInserts,
    agentUpdates,
    revocationInserts,
    agentRegistrationChallengeInserts,
    agentRegistrationChallengeUpdates,
    agentAuthSessionInserts,
    agentAuthSessionUpdates,
    agentAuthEventInserts,
    inviteInserts,
    inviteUpdates,
    revocationRows,
    registrationChallengeRows,
    agentAuthSessionRows,
    inviteRows,
    humanRows,
    apiKeyRows,
    beforeFirstAgentUpdateApplied: false,
    beforeFirstAgentAuthSessionUpdateApplied: false,
    remainingApiKeyInsertFailures: options.failApiKeyInsertCount ?? 0,
  };

  const database: D1Database = {
    prepare(query: string) {
      let params: unknown[] = [];
      const normalizedQuery = query.toLowerCase();

      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async all() {
          if (
            normalizedQuery.includes('from "api_keys"') ||
            normalizedQuery.includes("from api_keys")
          ) {
            const requiresHumanJoin =
              normalizedQuery.includes('join "humans"') ||
              normalizedQuery.includes("join humans");

            if (requiresHumanJoin) {
              const requestedKeyPrefix =
                typeof params[0] === "string" ? params[0] : "";
              const matchingRows = apiKeyRows.filter(
                (row) => row.keyPrefix === requestedKeyPrefix,
              );

              return {
                results: matchingRows
                  .map((row) => {
                    const human = humanRows.find(
                      (humanRow) => humanRow.id === row.humanId,
                    );
                    if (!human) {
                      return undefined;
                    }

                    return {
                      api_key_id: row.id,
                      key_hash: row.keyHash,
                      api_key_status: row.status,
                      api_key_name: row.name,
                      human_id: human.id,
                      human_did: human.did,
                      human_display_name: human.displayName,
                      human_role: human.role,
                      human_status: human.status,
                    };
                  })
                  .filter(isDefined),
              };
            }

            const resultRows = resolveApiKeySelectRows({
              query,
              params,
              apiKeyRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getApiKeySelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "humans"') ||
              normalizedQuery.includes("from humans")) &&
            normalizedQuery.includes("select")
          ) {
            const resultRows = resolveHumanSelectRows({
              query,
              params,
              humanRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getHumanSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agents"') ||
              normalizedQuery.includes("from agents")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentSelectRows({
              query,
              params,
              authRows: rows,
              agentRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getAgentSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agent_registration_challenges"') ||
              normalizedQuery.includes("from agent_registration_challenges")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentRegistrationChallengeSelectRows({
              query,
              params,
              challengeRows: registrationChallengeRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] =
                      getAgentRegistrationChallengeSelectColumnValue(
                        row,
                        column,
                      );
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agent_auth_sessions"') ||
              normalizedQuery.includes("from agent_auth_sessions")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentAuthSessionSelectRows({
              query,
              params,
              sessionRows: agentAuthSessionRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getAgentAuthSessionSelectColumnValue(
                      row,
                      column,
                    );
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "invites"') ||
              normalizedQuery.includes("from invites")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveInviteSelectRows({
              query,
              params,
              inviteRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getInviteSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "revocations"') ||
              normalizedQuery.includes("from revocations")) &&
            normalizedQuery.includes("select")
          ) {
            return {
              results: resolveCrlSelectRows({
                agentRows,
                revocationRows,
              }),
            };
          }
          return { results: [] };
        },
        async raw() {
          if (
            normalizedQuery.includes('from "api_keys"') ||
            normalizedQuery.includes("from api_keys")
          ) {
            const requiresHumanJoin =
              normalizedQuery.includes('join "humans"') ||
              normalizedQuery.includes("join humans");

            if (requiresHumanJoin) {
              const requestedKeyPrefix =
                typeof params[0] === "string" ? params[0] : "";
              const matchingRows = apiKeyRows.filter(
                (row) => row.keyPrefix === requestedKeyPrefix,
              );

              return matchingRows
                .map((row) => {
                  const human = humanRows.find(
                    (humanRow) => humanRow.id === row.humanId,
                  );
                  if (!human) {
                    return undefined;
                  }

                  return [
                    row.id,
                    row.keyHash,
                    row.status,
                    row.name,
                    human.id,
                    human.did,
                    human.displayName,
                    human.role,
                    human.status,
                  ];
                })
                .filter(isDefined);
            }

            const resultRows = resolveApiKeySelectRows({
              query,
              params,
              apiKeyRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getApiKeySelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agent_auth_sessions"') ||
            normalizedQuery.includes("from agent_auth_sessions")
          ) {
            const resultRows = resolveAgentAuthSessionSelectRows({
              query,
              params,
              sessionRows: agentAuthSessionRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentAuthSessionSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "humans"') ||
            normalizedQuery.includes("from humans")
          ) {
            const resultRows = resolveHumanSelectRows({
              query,
              params,
              humanRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getHumanSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agents"') ||
            normalizedQuery.includes("from agents")
          ) {
            const resultRows = resolveAgentSelectRows({
              query,
              params,
              authRows: rows,
              agentRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agent_registration_challenges"') ||
            normalizedQuery.includes("from agent_registration_challenges")
          ) {
            const resultRows = resolveAgentRegistrationChallengeSelectRows({
              query,
              params,
              challengeRows: registrationChallengeRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentRegistrationChallengeSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "invites"') ||
            normalizedQuery.includes("from invites")
          ) {
            const resultRows = resolveInviteSelectRows({
              query,
              params,
              inviteRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getInviteSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "revocations"') ||
            normalizedQuery.includes("from revocations")
          ) {
            const resultRows = resolveCrlSelectRows({
              agentRows,
              revocationRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getCrlSelectColumnValue(row, column),
              ),
            );
          }
          return [];
        },
        async run() {
          return handleRunQuery({
            query,
            normalizedQuery,
            params,
            state,
          });
        },
      } as D1PreparedStatement;
    },
  } as D1Database;

  return {
    database,
    updates,
    humanRows,
    humanInserts,
    apiKeyInserts,
    agentAuthSessionRows,
    agentAuthSessionInserts,
    agentAuthSessionUpdates,
    agentAuthEventInserts,
    agentInserts,
    agentUpdates,
    agentRegistrationChallengeInserts,
    agentRegistrationChallengeUpdates,
    inviteInserts,
    inviteUpdates,
    inviteRows,
    revocationInserts,
    registrationChallengeRows,
  };
}
