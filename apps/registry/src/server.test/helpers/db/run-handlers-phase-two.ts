import {
  extractWhereClause,
  hasFilter,
  parseInsertColumns,
  parseUpdateSetColumns,
  parseWhereEqualityParams,
} from "./parse.js";
import type { RunHandlerPhaseInput } from "./run-handlers-types.js";
import type {
  FakeAgentInsertRow,
  FakeAgentRegistrationChallengeInsertRow,
  FakeInviteInsertRow,
  FakeRevocationInsertRow,
} from "./types.js";

export function applyRunHandlersPhaseTwo(input: RunHandlerPhaseInput): number {
  const { query, normalizedQuery, params, state } = input;
  let { changes } = input;
  const {
    inviteInserts,
    inviteRows,
    inviteUpdates,
    humanRows,
    apiKeyRows,
    agentInserts,
    agentRegistrationChallengeInserts,
    registrationChallengeRows,
    agentRegistrationChallengeUpdates,
    agentRows,
    agentUpdates,
    revocationInserts,
    revocationRows,
  } = state;
  const options = state.options;

  if (
    normalizedQuery.includes('insert into "invites"') ||
    normalizedQuery.includes("insert into invites")
  ) {
    const columns = parseInsertColumns(query, "invites");
    const row = columns.reduce<FakeInviteInsertRow>((acc, column, index) => {
      acc[column] = params[index];
      return acc;
    }, {});
    inviteInserts.push(row);

    if (
      typeof row.id === "string" &&
      typeof row.code === "string" &&
      typeof row.created_by === "string" &&
      typeof row.created_at === "string"
    ) {
      inviteRows.push({
        id: row.id,
        code: row.code,
        createdBy: row.created_by,
        redeemedBy:
          typeof row.redeemed_by === "string" ? row.redeemed_by : null,
        agentId: typeof row.agent_id === "string" ? row.agent_id : null,
        expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
        createdAt: row.created_at,
      });
    }

    changes = 1;
  }
  if (
    normalizedQuery.includes('update "invites"') ||
    normalizedQuery.includes("update invites")
  ) {
    const setColumns = parseUpdateSetColumns(query, "invites");
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
    const redeemedByFilter = hasFilter(whereClause, "redeemed_by")
      ? (equalityParams.values.redeemed_by?.[0] as string | null | undefined)
      : undefined;
    const requiresRedeemedByNull =
      whereClause.includes("redeemed_by") && whereClause.includes("is null");

    let matchedRows = 0;
    for (const row of inviteRows) {
      if (idFilter && row.id !== idFilter) {
        continue;
      }
      if (requiresRedeemedByNull && row.redeemedBy !== null) {
        continue;
      }
      if (
        redeemedByFilter !== undefined &&
        row.redeemedBy !== redeemedByFilter
      ) {
        continue;
      }

      matchedRows += 1;
      if (
        typeof nextValues.redeemed_by === "string" ||
        nextValues.redeemed_by === null
      ) {
        row.redeemedBy = nextValues.redeemed_by;
      }
    }

    inviteUpdates.push({
      ...nextValues,
      id: idFilter,
      redeemed_by_where: redeemedByFilter,
      redeemed_by_is_null_where: requiresRedeemedByNull,
      matched_rows: matchedRows,
    });
    changes = matchedRows;
  }
  if (
    normalizedQuery.includes('delete from "humans"') ||
    normalizedQuery.includes("delete from humans")
  ) {
    const whereClause = extractWhereClause(query);
    const equalityParams = parseWhereEqualityParams({
      whereClause,
      params,
    });
    const idFilter =
      typeof equalityParams.values.id?.[0] === "string"
        ? String(equalityParams.values.id[0])
        : "";

    if (idFilter.length > 0) {
      for (let index = humanRows.length - 1; index >= 0; index -= 1) {
        if (humanRows[index]?.id === idFilter) {
          humanRows.splice(index, 1);
          changes += 1;
        }
      }

      for (let index = apiKeyRows.length - 1; index >= 0; index -= 1) {
        if (apiKeyRows[index]?.humanId === idFilter) {
          apiKeyRows.splice(index, 1);
        }
      }
    }
  }
  if (
    normalizedQuery.includes('insert into "agents"') ||
    normalizedQuery.includes("insert into agents")
  ) {
    const columns = parseInsertColumns(query, "agents");
    const row = columns.reduce<FakeAgentInsertRow>((acc, column, index) => {
      acc[column] = params[index];
      return acc;
    }, {});
    agentInserts.push(row);
    changes = 1;
  }
  if (
    normalizedQuery.includes('insert into "agent_registration_challenges"') ||
    normalizedQuery.includes("insert into agent_registration_challenges")
  ) {
    const columns = parseInsertColumns(query, "agent_registration_challenges");
    const row = columns.reduce<FakeAgentRegistrationChallengeInsertRow>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    agentRegistrationChallengeInserts.push(row);

    if (
      typeof row.id === "string" &&
      typeof row.owner_id === "string" &&
      typeof row.public_key === "string" &&
      typeof row.nonce === "string" &&
      (row.status === "pending" || row.status === "used") &&
      typeof row.expires_at === "string" &&
      typeof row.created_at === "string" &&
      typeof row.updated_at === "string"
    ) {
      registrationChallengeRows.push({
        id: row.id,
        ownerId: row.owner_id,
        publicKey: row.public_key,
        nonce: row.nonce,
        status: row.status,
        expiresAt: row.expires_at,
        usedAt: typeof row.used_at === "string" ? String(row.used_at) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    changes = 1;
  }
  if (
    normalizedQuery.includes('update "agent_registration_challenges"') ||
    normalizedQuery.includes("update agent_registration_challenges")
  ) {
    const setColumns = parseUpdateSetColumns(
      query,
      "agent_registration_challenges",
    );
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
    const ownerFilter =
      typeof equalityParams.values.owner_id?.[0] === "string"
        ? String(equalityParams.values.owner_id[0])
        : undefined;
    const statusFilter =
      typeof equalityParams.values.status?.[0] === "string"
        ? String(equalityParams.values.status[0])
        : undefined;

    let matchedRows = 0;
    for (const row of registrationChallengeRows) {
      if (idFilter && row.id !== idFilter) {
        continue;
      }
      if (ownerFilter && row.ownerId !== ownerFilter) {
        continue;
      }
      if (statusFilter && row.status !== statusFilter) {
        continue;
      }

      matchedRows += 1;
      if (nextValues.status === "pending" || nextValues.status === "used") {
        row.status = nextValues.status;
      }
      if (
        typeof nextValues.used_at === "string" ||
        nextValues.used_at === null
      ) {
        row.usedAt = nextValues.used_at;
      }
      if (typeof nextValues.updated_at === "string") {
        row.updatedAt = nextValues.updated_at;
      }
    }

    agentRegistrationChallengeUpdates.push({
      ...nextValues,
      id: idFilter,
      owner_id: ownerFilter,
      status_where: statusFilter,
      matched_rows: matchedRows,
    });
    changes = matchedRows;
  }
  if (
    normalizedQuery.includes('update "agents"') ||
    normalizedQuery.includes("update agents")
  ) {
    if (
      !state.beforeFirstAgentUpdateApplied &&
      options.beforeFirstAgentUpdate
    ) {
      options.beforeFirstAgentUpdate(agentRows);
      state.beforeFirstAgentUpdateApplied = true;
    }

    const setColumns = parseUpdateSetColumns(query, "agents");
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
    const ownerFilter =
      typeof equalityParams.values.owner_id?.[0] === "string"
        ? String(equalityParams.values.owner_id?.[0])
        : undefined;
    const idFilter =
      typeof equalityParams.values.id?.[0] === "string"
        ? String(equalityParams.values.id?.[0])
        : undefined;
    const statusFilter =
      typeof equalityParams.values.status?.[0] === "string"
        ? String(equalityParams.values.status?.[0])
        : undefined;
    const currentJtiFilter = equalityParams.values.current_jti?.[0] as
      | string
      | null
      | undefined;

    let matchedRows = 0;

    for (const row of agentRows) {
      if (ownerFilter && row.ownerId !== ownerFilter) {
        continue;
      }
      if (idFilter && row.id !== idFilter) {
        continue;
      }
      if (
        statusFilter &&
        row.status !== (statusFilter as "active" | "revoked")
      ) {
        continue;
      }
      if (
        currentJtiFilter !== undefined &&
        (row.currentJti ?? null) !== currentJtiFilter
      ) {
        continue;
      }

      matchedRows += 1;

      if (nextValues.status === "active" || nextValues.status === "revoked") {
        row.status = nextValues.status;
      }
      if (typeof nextValues.updated_at === "string") {
        row.updatedAt = nextValues.updated_at;
      }
      if (
        typeof nextValues.current_jti === "string" ||
        nextValues.current_jti === null
      ) {
        row.currentJti = nextValues.current_jti;
      }
      if (
        typeof nextValues.expires_at === "string" ||
        nextValues.expires_at === null
      ) {
        row.expiresAt = nextValues.expires_at;
      }
    }

    agentUpdates.push({
      ...nextValues,
      owner_id: ownerFilter,
      id: idFilter,
      status_where: statusFilter,
      current_jti_where: currentJtiFilter,
      matched_rows: matchedRows,
    });
    changes = matchedRows;
  }
  if (
    normalizedQuery.includes('insert into "revocations"') ||
    normalizedQuery.includes("insert into revocations")
  ) {
    const columns = parseInsertColumns(query, "revocations");
    const row = columns.reduce<FakeRevocationInsertRow>(
      (acc, column, index) => {
        acc[column] = params[index];
        return acc;
      },
      {},
    );
    revocationInserts.push(row);
    if (
      typeof row.id === "string" &&
      typeof row.jti === "string" &&
      typeof row.agent_id === "string" &&
      typeof row.revoked_at === "string"
    ) {
      revocationRows.push({
        id: row.id,
        jti: row.jti,
        agentId: row.agent_id,
        reason: typeof row.reason === "string" ? row.reason : null,
        revokedAt: row.revoked_at,
      });
    }
    changes = 1;
  }

  return changes;
}
