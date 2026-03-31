import { extractWhereClause, parseWhereEqualityParams } from "../parse.js";
import type { FakeGroupRow } from "../types.js";

export function getGroupSelectColumnValue(
  row: FakeGroupRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "name") {
    return row.name;
  }
  if (column === "created_by") {
    return row.createdBy;
  }
  if (column === "created_at") {
    return row.createdAt;
  }
  if (column === "updated_at") {
    return row.updatedAt;
  }
  return undefined;
}

export function resolveGroupSelectRows(options: {
  query: string;
  params: unknown[];
  groupRows: FakeGroupRow[];
}): FakeGroupRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });

  const idFilter =
    typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.groupRows.length;

  return options.groupRows
    .filter((row) => (idFilter ? row.id === idFilter : true))
    .slice(0, limit);
}
