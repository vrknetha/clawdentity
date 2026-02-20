import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeInviteRow } from "../types.js";

export function getInviteSelectColumnValue(
  row: FakeInviteRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "code") {
    return row.code;
  }
  if (column === "created_by") {
    return row.createdBy;
  }
  if (column === "redeemed_by") {
    return row.redeemedBy;
  }
  if (column === "agent_id") {
    return row.agentId;
  }
  if (column === "expires_at") {
    return row.expiresAt;
  }
  if (column === "created_at") {
    return row.createdAt;
  }
  return undefined;
}

export function resolveInviteSelectRows(options: {
  query: string;
  params: unknown[];
  inviteRows: FakeInviteRow[];
}): FakeInviteRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasCodeFilter = hasFilter(whereClause, "code");
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasRedeemedByFilter = hasFilter(whereClause, "redeemed_by");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");

  const codeFilter =
    hasCodeFilter && typeof equalityParams.values.code?.[0] === "string"
      ? String(equalityParams.values.code[0])
      : undefined;
  const idFilter =
    hasIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const redeemedByFilter = hasRedeemedByFilter
    ? (equalityParams.values.redeemed_by?.[0] as string | null | undefined)
    : undefined;

  const requiresRedeemedByNull =
    whereClause.includes("redeemed_by") && whereClause.includes("is null");

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.inviteRows.length;

  return options.inviteRows
    .filter((row) => (codeFilter ? row.code === codeFilter : true))
    .filter((row) => (idFilter ? row.id === idFilter : true))
    .filter((row) =>
      redeemedByFilter !== undefined
        ? row.redeemedBy === redeemedByFilter
        : true,
    )
    .filter((row) => (requiresRedeemedByNull ? row.redeemedBy === null : true))
    .slice(0, limit);
}
