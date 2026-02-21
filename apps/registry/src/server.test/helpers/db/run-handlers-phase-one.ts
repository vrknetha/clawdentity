import {
  extractWhereClause,
  parseInsertColumns,
  parseUpdateSetColumns,
  parseWhereEqualityParams,
} from "./parse.js";
import type { RunHandlerPhaseInput } from "./run-handlers-types.js";
import type {
  FakeAgentAuthEventInsertRow,
  FakeAgentAuthSessionInsertRow,
  FakeAgentAuthSessionRow,
  FakeApiKeyInsertRow,
  FakeHumanInsertRow,
} from "./types.js";

export function applyRunHandlersPhaseOne(input: RunHandlerPhaseInput): number {
  const { query, normalizedQuery, params, state } = input;
  let { changes } = input;
  const {
    apiKeyRows,
    updates,
    humanInserts,
    humanRows,
    apiKeyInserts,
    agentAuthSessionInserts,
    agentAuthSessionRows,
    agentAuthEventInserts,
    agentAuthSessionUpdates,
  } = state;
  const options = state.options;

  if (
    normalizedQuery.includes('update "api_keys"') ||
    normalizedQuery.includes("update api_keys")
  ) {
    const setColumns = parseUpdateSetColumns(query, "api_keys");
    const nextValues = setColumns.reduce<Record<string, unknown>>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    const whereClause = extractWhereClause(query);
    const whereParams = params.slice(setColumns.length);
    const equalityParams = parseWhereEqualityParams({
      whereClause,
      params: whereParams,
    });
    const idFilter =
      typeof equalityParams.values.id?.[0] === "string"
        ? String(equalityParams.values.id[0])
        : undefined;
    const humanIdFilter =
      typeof equalityParams.values.human_id?.[0] === "string"
        ? String(equalityParams.values.human_id[0])
        : undefined;
    const statusFilter =
      typeof equalityParams.values.status?.[0] === "string"
        ? String(equalityParams.values.status[0])
        : undefined;

    let matchedRows = 0;
    for (const row of apiKeyRows) {
      if (idFilter && row.id !== idFilter) {
        continue;
      }
      if (humanIdFilter && row.humanId !== humanIdFilter) {
        continue;
      }
      if (statusFilter && row.status !== statusFilter) {
        continue;
      }

      matchedRows += 1;
      if (nextValues.status === "active" || nextValues.status === "revoked") {
        row.status = nextValues.status;
      }
      if (
        typeof nextValues.last_used_at === "string" ||
        nextValues.last_used_at === null
      ) {
        row.lastUsedAt = nextValues.last_used_at;
      }
    }

    if (typeof nextValues.last_used_at === "string" && idFilter) {
      updates.push({
        lastUsedAt: nextValues.last_used_at,
        apiKeyId: idFilter,
      });
    }
    changes = matchedRows;
  }
  if (
    normalizedQuery.includes('insert into "humans"') ||
    normalizedQuery.includes("insert into humans")
  ) {
    const columns = parseInsertColumns(query, "humans");
    const row = columns.reduce<FakeHumanInsertRow>((acc, column, index) => {
      acc[column] = params[index];
      return acc;
    }, {});
    humanInserts.push(row);

    const nextHumanId = typeof row.id === "string" ? row.id : "";
    const nextHumanDid = typeof row.did === "string" ? row.did : "";
    const conflict = humanRows.some(
      (humanRow) =>
        humanRow.id === nextHumanId || humanRow.did === nextHumanDid,
    );

    if (!conflict) {
      if (
        (row.role === "admin" || row.role === "user") &&
        (row.status === "active" || row.status === "suspended") &&
        typeof row.display_name === "string" &&
        typeof row.created_at === "string" &&
        typeof row.updated_at === "string"
      ) {
        humanRows.push({
          id: nextHumanId,
          did: nextHumanDid,
          displayName: row.display_name,
          role: row.role,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      }

      changes = 1;
    } else {
      changes = 0;
    }
  }
  if (
    normalizedQuery.includes('insert into "api_keys"') ||
    normalizedQuery.includes("insert into api_keys")
  ) {
    if (state.remainingApiKeyInsertFailures > 0) {
      state.remainingApiKeyInsertFailures -= 1;
      throw new Error("api key insert failed");
    }

    const columns = parseInsertColumns(query, "api_keys");
    const row = columns.reduce<FakeApiKeyInsertRow>((acc, column, index) => {
      acc[column] = params[index];
      return acc;
    }, {});
    apiKeyInserts.push(row);

    if (
      typeof row.id === "string" &&
      typeof row.human_id === "string" &&
      typeof row.key_hash === "string" &&
      typeof row.key_prefix === "string" &&
      typeof row.name === "string" &&
      (row.status === "active" || row.status === "revoked") &&
      typeof row.created_at === "string"
    ) {
      apiKeyRows.push({
        id: row.id,
        humanId: row.human_id,
        keyHash: row.key_hash,
        keyPrefix: row.key_prefix,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        lastUsedAt:
          typeof row.last_used_at === "string" ? row.last_used_at : null,
      });
    }

    changes = 1;
  }
  if (
    normalizedQuery.includes('insert into "agent_auth_sessions"') ||
    normalizedQuery.includes("insert into agent_auth_sessions")
  ) {
    const columns = parseInsertColumns(query, "agent_auth_sessions");
    const row = columns.reduce<FakeAgentAuthSessionInsertRow>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    agentAuthSessionInserts.push(row);

    if (
      typeof row.id === "string" &&
      typeof row.agent_id === "string" &&
      typeof row.refresh_key_hash === "string" &&
      typeof row.refresh_key_prefix === "string" &&
      typeof row.refresh_issued_at === "string" &&
      typeof row.refresh_expires_at === "string" &&
      typeof row.access_key_hash === "string" &&
      typeof row.access_key_prefix === "string" &&
      typeof row.access_issued_at === "string" &&
      typeof row.access_expires_at === "string" &&
      (row.status === "active" || row.status === "revoked") &&
      typeof row.created_at === "string" &&
      typeof row.updated_at === "string"
    ) {
      const existingIndex = agentAuthSessionRows.findIndex(
        (sessionRow) => sessionRow.agentId === row.agent_id,
      );
      const nextSession: FakeAgentAuthSessionRow = {
        id: row.id,
        agentId: row.agent_id,
        refreshKeyHash: row.refresh_key_hash,
        refreshKeyPrefix: row.refresh_key_prefix,
        refreshIssuedAt: row.refresh_issued_at,
        refreshExpiresAt: row.refresh_expires_at,
        refreshLastUsedAt:
          typeof row.refresh_last_used_at === "string"
            ? row.refresh_last_used_at
            : null,
        accessKeyHash: row.access_key_hash,
        accessKeyPrefix: row.access_key_prefix,
        accessIssuedAt: row.access_issued_at,
        accessExpiresAt: row.access_expires_at,
        accessLastUsedAt:
          typeof row.access_last_used_at === "string"
            ? row.access_last_used_at
            : null,
        status: row.status,
        revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      if (existingIndex >= 0) {
        agentAuthSessionRows.splice(existingIndex, 1, nextSession);
      } else {
        agentAuthSessionRows.push(nextSession);
      }
    }

    changes = 1;
  }
  if (
    normalizedQuery.includes('insert into "agent_auth_events"') ||
    normalizedQuery.includes("insert into agent_auth_events")
  ) {
    const columns = parseInsertColumns(query, "agent_auth_events");
    const row = columns.reduce<FakeAgentAuthEventInsertRow>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    agentAuthEventInserts.push(row);
    changes = 1;
  }
  if (
    normalizedQuery.includes('update "agent_auth_sessions"') ||
    normalizedQuery.includes("update agent_auth_sessions")
  ) {
    if (
      !state.beforeFirstAgentAuthSessionUpdateApplied &&
      options.beforeFirstAgentAuthSessionUpdate
    ) {
      options.beforeFirstAgentAuthSessionUpdate(agentAuthSessionRows);
      state.beforeFirstAgentAuthSessionUpdateApplied = true;
    }

    const setColumns = parseUpdateSetColumns(query, "agent_auth_sessions");
    const nextValues = setColumns.reduce<Record<string, unknown>>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    const whereClause = extractWhereClause(query);
    const whereParams = params.slice(setColumns.length);
    const equalityParams = parseWhereEqualityParams({
      whereClause,
      params: whereParams,
    });

    const idFilter =
      typeof equalityParams.values.id?.[0] === "string"
        ? String(equalityParams.values.id[0])
        : undefined;
    const agentIdFilter =
      typeof equalityParams.values.agent_id?.[0] === "string"
        ? String(equalityParams.values.agent_id[0])
        : undefined;
    const statusFilter =
      typeof equalityParams.values.status?.[0] === "string"
        ? String(equalityParams.values.status[0])
        : undefined;
    const refreshHashFilter =
      typeof equalityParams.values.refresh_key_hash?.[0] === "string"
        ? String(equalityParams.values.refresh_key_hash[0])
        : undefined;
    const accessHashFilter =
      typeof equalityParams.values.access_key_hash?.[0] === "string"
        ? String(equalityParams.values.access_key_hash[0])
        : undefined;

    let matchedRows = 0;
    for (const row of agentAuthSessionRows) {
      if (idFilter && row.id !== idFilter) {
        continue;
      }
      if (agentIdFilter && row.agentId !== agentIdFilter) {
        continue;
      }
      if (statusFilter && row.status !== statusFilter) {
        continue;
      }
      if (refreshHashFilter && row.refreshKeyHash !== refreshHashFilter) {
        continue;
      }
      if (accessHashFilter && row.accessKeyHash !== accessHashFilter) {
        continue;
      }

      matchedRows += 1;
      if (typeof nextValues.refresh_key_hash === "string") {
        row.refreshKeyHash = nextValues.refresh_key_hash;
      }
      if (typeof nextValues.refresh_key_prefix === "string") {
        row.refreshKeyPrefix = nextValues.refresh_key_prefix;
      }
      if (typeof nextValues.refresh_issued_at === "string") {
        row.refreshIssuedAt = nextValues.refresh_issued_at;
      }
      if (typeof nextValues.refresh_expires_at === "string") {
        row.refreshExpiresAt = nextValues.refresh_expires_at;
      }
      if (
        typeof nextValues.refresh_last_used_at === "string" ||
        nextValues.refresh_last_used_at === null
      ) {
        row.refreshLastUsedAt = nextValues.refresh_last_used_at;
      }
      if (typeof nextValues.access_key_hash === "string") {
        row.accessKeyHash = nextValues.access_key_hash;
      }
      if (typeof nextValues.access_key_prefix === "string") {
        row.accessKeyPrefix = nextValues.access_key_prefix;
      }
      if (typeof nextValues.access_issued_at === "string") {
        row.accessIssuedAt = nextValues.access_issued_at;
      }
      if (typeof nextValues.access_expires_at === "string") {
        row.accessExpiresAt = nextValues.access_expires_at;
      }
      if (
        typeof nextValues.access_last_used_at === "string" ||
        nextValues.access_last_used_at === null
      ) {
        row.accessLastUsedAt = nextValues.access_last_used_at;
      }
      if (nextValues.status === "active" || nextValues.status === "revoked") {
        row.status = nextValues.status;
      }
      if (
        typeof nextValues.revoked_at === "string" ||
        nextValues.revoked_at === null
      ) {
        row.revokedAt = nextValues.revoked_at;
      }
      if (typeof nextValues.updated_at === "string") {
        row.updatedAt = nextValues.updated_at;
      }
    }

    agentAuthSessionUpdates.push({
      ...nextValues,
      id: idFilter,
      agent_id: agentIdFilter,
      status_where: statusFilter,
      refresh_key_hash_where: refreshHashFilter,
      access_key_hash_where: accessHashFilter,
      matched_rows: matchedRows,
    });
    changes = matchedRows;
  }
  if (
    normalizedQuery.includes('delete from "agent_auth_sessions"') ||
    normalizedQuery.includes("delete from agent_auth_sessions")
  ) {
    const whereClause = extractWhereClause(query);
    const equalityParams = parseWhereEqualityParams({
      whereClause,
      params,
    });
    const idFilter =
      typeof equalityParams.values.id?.[0] === "string"
        ? String(equalityParams.values.id[0])
        : undefined;

    if (idFilter) {
      for (
        let index = agentAuthSessionRows.length - 1;
        index >= 0;
        index -= 1
      ) {
        if (agentAuthSessionRows[index]?.id === idFilter) {
          agentAuthSessionRows.splice(index, 1);
          changes += 1;
        }
      }
    }
  }

  return changes;
}
