import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeAgentAuthSessionRow } from "../types.js";

export function getAgentAuthSessionSelectColumnValue(
  row: FakeAgentAuthSessionRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "agent_id") {
    return row.agentId;
  }
  if (column === "refresh_key_hash") {
    return row.refreshKeyHash;
  }
  if (column === "refresh_key_prefix") {
    return row.refreshKeyPrefix;
  }
  if (column === "refresh_issued_at") {
    return row.refreshIssuedAt;
  }
  if (column === "refresh_expires_at") {
    return row.refreshExpiresAt;
  }
  if (column === "refresh_last_used_at") {
    return row.refreshLastUsedAt;
  }
  if (column === "access_key_hash") {
    return row.accessKeyHash;
  }
  if (column === "access_key_prefix") {
    return row.accessKeyPrefix;
  }
  if (column === "access_issued_at") {
    return row.accessIssuedAt;
  }
  if (column === "access_expires_at") {
    return row.accessExpiresAt;
  }
  if (column === "access_last_used_at") {
    return row.accessLastUsedAt;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "revoked_at") {
    return row.revokedAt;
  }
  if (column === "created_at") {
    return row.createdAt;
  }
  if (column === "updated_at") {
    return row.updatedAt;
  }
  return undefined;
}

export function resolveAgentAuthSessionSelectRows(options: {
  query: string;
  params: unknown[];
  sessionRows: FakeAgentAuthSessionRow[];
}): FakeAgentAuthSessionRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasAgentIdFilter = hasFilter(whereClause, "agent_id");
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasRefreshPrefixFilter = hasFilter(whereClause, "refresh_key_prefix");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");

  const agentId =
    hasAgentIdFilter && typeof equalityParams.values.agent_id?.[0] === "string"
      ? String(equalityParams.values.agent_id[0])
      : undefined;
  const id =
    hasIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const status =
    hasStatusFilter && typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;
  const refreshPrefix =
    hasRefreshPrefixFilter &&
    typeof equalityParams.values.refresh_key_prefix?.[0] === "string"
      ? String(equalityParams.values.refresh_key_prefix[0])
      : undefined;

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.sessionRows.length;

  return options.sessionRows
    .filter((row) => (agentId ? row.agentId === agentId : true))
    .filter((row) => (id ? row.id === id : true))
    .filter((row) => (status ? row.status === status : true))
    .filter((row) =>
      refreshPrefix ? row.refreshKeyPrefix === refreshPrefix : true,
    )
    .slice(0, limit);
}
