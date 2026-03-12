import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeInternalServiceRow } from "../types.js";

type FakeInternalServiceSelectRow = {
  id: string;
  name: string;
  secret_hash: string;
  secret_prefix: string;
  scopes_json: string;
  status: "active" | "revoked";
  created_by: string;
  rotated_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export function getInternalServiceSelectColumnValue(
  row: FakeInternalServiceSelectRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "name") {
    return row.name;
  }
  if (column === "secret_hash") {
    return row.secret_hash;
  }
  if (column === "secret_prefix") {
    return row.secret_prefix;
  }
  if (column === "scopes_json") {
    return row.scopes_json;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "created_by") {
    return row.created_by;
  }
  if (column === "rotated_at") {
    return row.rotated_at;
  }
  if (column === "last_used_at") {
    return row.last_used_at;
  }
  if (column === "created_at") {
    return row.created_at;
  }
  if (column === "updated_at") {
    return row.updated_at;
  }
  return undefined;
}

export function resolveInternalServiceSelectRows(options: {
  query: string;
  params: unknown[];
  internalServiceRows: FakeInternalServiceRow[];
}): FakeInternalServiceSelectRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasNameFilter = hasFilter(whereClause, "name");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasSecretPrefixFilter = hasFilter(whereClause, "secret_prefix");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const orderByCreatedAtDesc =
    options.query.toLowerCase().includes("order by") &&
    options.query.toLowerCase().includes("created_at") &&
    options.query.toLowerCase().includes("desc");

  const id =
    hasIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const name =
    hasNameFilter && typeof equalityParams.values.name?.[0] === "string"
      ? String(equalityParams.values.name[0])
      : undefined;
  const status =
    hasStatusFilter && typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;
  const secretPrefix =
    hasSecretPrefixFilter &&
    typeof equalityParams.values.secret_prefix?.[0] === "string"
      ? String(equalityParams.values.secret_prefix[0])
      : undefined;

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.internalServiceRows.length;

  const rows = options.internalServiceRows
    .filter((row) => (id ? row.id === id : true))
    .filter((row) => (name ? row.name === name : true))
    .filter((row) => (status ? row.status === status : true))
    .filter((row) => (secretPrefix ? row.secretPrefix === secretPrefix : true))
    .map((row) => ({
      id: row.id,
      name: row.name,
      secret_hash: row.secretHash,
      secret_prefix: row.secretPrefix,
      scopes_json: row.scopesJson,
      status: row.status,
      created_by: row.createdBy,
      rotated_at: row.rotatedAt,
      last_used_at: row.lastUsedAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
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
