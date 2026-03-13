import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeStarterPassRow } from "../types.js";

export function getStarterPassSelectColumnValue(
  row: FakeStarterPassRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "code") {
    return row.code;
  }
  if (column === "provider") {
    return row.provider;
  }
  if (column === "provider_subject") {
    return row.providerSubject;
  }
  if (column === "provider_login") {
    return row.providerLogin;
  }
  if (column === "display_name") {
    return row.displayName;
  }
  if (column === "redeemed_by") {
    return row.redeemedBy;
  }
  if (column === "issued_at") {
    return row.issuedAt;
  }
  if (column === "redeemed_at") {
    return row.redeemedAt;
  }
  if (column === "expires_at") {
    return row.expiresAt;
  }
  if (column === "status") {
    return row.status;
  }
  return undefined;
}

export function resolveStarterPassSelectRows(options: {
  query: string;
  params: unknown[];
  starterPassRows: FakeStarterPassRow[];
}): FakeStarterPassRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });

  const codeFilter =
    hasFilter(whereClause, "code") &&
    typeof equalityParams.values.code?.[0] === "string"
      ? String(equalityParams.values.code[0])
      : undefined;
  const idFilter =
    hasFilter(whereClause, "id") &&
    typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const providerFilter =
    hasFilter(whereClause, "provider") &&
    typeof equalityParams.values.provider?.[0] === "string"
      ? String(equalityParams.values.provider[0])
      : undefined;
  const providerSubjectFilter =
    hasFilter(whereClause, "provider_subject") &&
    typeof equalityParams.values.provider_subject?.[0] === "string"
      ? String(equalityParams.values.provider_subject[0])
      : undefined;
  const statusFilter =
    hasFilter(whereClause, "status") &&
    typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;
  const redeemedByFilter = hasFilter(whereClause, "redeemed_by")
    ? (equalityParams.values.redeemed_by?.[0] as string | null | undefined)
    : undefined;
  const requiresRedeemedByNull =
    whereClause.includes("redeemed_by") && whereClause.includes("is null");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.starterPassRows.length;

  return options.starterPassRows
    .filter((row) => (codeFilter ? row.code === codeFilter : true))
    .filter((row) => (idFilter ? row.id === idFilter : true))
    .filter((row) => (providerFilter ? row.provider === providerFilter : true))
    .filter((row) =>
      providerSubjectFilter
        ? row.providerSubject === providerSubjectFilter
        : true,
    )
    .filter((row) => (statusFilter ? row.status === statusFilter : true))
    .filter((row) =>
      redeemedByFilter !== undefined
        ? row.redeemedBy === redeemedByFilter
        : true,
    )
    .filter((row) => (requiresRedeemedByNull ? row.redeemedBy === null : true))
    .slice(0, limit);
}
