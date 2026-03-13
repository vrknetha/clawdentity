import { extractWhereClause, parseWhereEqualityParams } from "../parse.js";
import type { FakeHumanRow } from "../types.js";

export function getHumanSelectColumnValue(
  row: FakeHumanRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "did") {
    return row.did;
  }
  if (column === "display_name") {
    return row.displayName;
  }
  if (column === "role") {
    return row.role;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "onboarding_source") {
    return row.onboardingSource;
  }
  if (column === "agent_limit") {
    return row.agentLimit;
  }
  if (column === "created_at") {
    return row.createdAt;
  }
  if (column === "updated_at") {
    return row.updatedAt;
  }
  return undefined;
}

export function resolveHumanSelectRows(options: {
  query: string;
  params: unknown[];
  humanRows: FakeHumanRow[];
}): FakeHumanRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });

  const roleFilter =
    typeof equalityParams.values.role?.[0] === "string"
      ? String(equalityParams.values.role[0])
      : undefined;
  const statusFilter =
    typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;
  const idFilter =
    typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const didFilter =
    typeof equalityParams.values.did?.[0] === "string"
      ? String(equalityParams.values.did[0])
      : undefined;

  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.humanRows.length;

  return options.humanRows
    .filter((row) => (roleFilter ? row.role === roleFilter : true))
    .filter((row) => (statusFilter ? row.status === statusFilter : true))
    .filter((row) => (idFilter ? row.id === idFilter : true))
    .filter((row) => (didFilter ? row.did === didFilter : true))
    .slice(0, limit);
}
