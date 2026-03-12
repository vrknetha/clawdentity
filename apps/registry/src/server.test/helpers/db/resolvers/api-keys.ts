import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeApiKeyRow, FakeApiKeySelectRow } from "../types.js";

export function getApiKeySelectColumnValue(
  row: FakeApiKeySelectRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "human_id") {
    return row.human_id;
  }
  if (column === "key_hash") {
    return row.key_hash;
  }
  if (column === "key_prefix") {
    return row.key_prefix;
  }
  if (column === "name") {
    return row.name;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "created_at") {
    return row.created_at;
  }
  if (column === "last_used_at") {
    return row.last_used_at;
  }
  return undefined;
}

export function resolveApiKeySelectRows(options: {
  query: string;
  params: unknown[];
  apiKeyRows: FakeApiKeyRow[];
}): FakeApiKeySelectRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasHumanIdFilter = hasFilter(whereClause, "human_id");
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasPrefixFilter = hasFilter(whereClause, "key_prefix");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const orderByCreatedAtDesc =
    options.query.toLowerCase().includes("order by") &&
    options.query.toLowerCase().includes("created_at") &&
    options.query.toLowerCase().includes("desc");

  const humanId =
    hasHumanIdFilter && typeof equalityParams.values.human_id?.[0] === "string"
      ? String(equalityParams.values.human_id[0])
      : undefined;
  const id =
    hasIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const status =
    hasStatusFilter && typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;
  const keyPrefix =
    hasPrefixFilter && typeof equalityParams.values.key_prefix?.[0] === "string"
      ? String(equalityParams.values.key_prefix[0])
      : undefined;

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.apiKeyRows.length;

  const rows = options.apiKeyRows
    .filter((row) => (humanId ? row.humanId === humanId : true))
    .filter((row) => (id ? row.id === id : true))
    .filter((row) => (status ? row.status === status : true))
    .filter((row) => (keyPrefix ? row.keyPrefix === keyPrefix : true))
    .map((row) => ({
      id: row.id,
      human_id: row.humanId,
      key_hash: row.keyHash,
      key_prefix: row.keyPrefix,
      name: row.name,
      status: row.status,
      created_at: row.createdAt,
      last_used_at: row.lastUsedAt,
    }));

  if (orderByCreatedAtDesc) {
    rows.sort((left, right) => {
      const createdAtCompare = right.created_at.localeCompare(left.created_at);
      if (createdAtCompare !== 0) {
        return createdAtCompare;
      }
      return right.id.localeCompare(left.id);
    });
  }

  return rows.slice(0, limit);
}
