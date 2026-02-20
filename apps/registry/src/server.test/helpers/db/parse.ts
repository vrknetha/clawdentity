// SQL helper parsers for the fake D1 database.
export function parseInsertColumns(query: string, tableName: string): string[] {
  const match = query.match(
    new RegExp(`insert\\s+into\\s+"?${tableName}"?\\s*\\(([^)]+)\\)`, "i"),
  );
  if (!match) {
    return [];
  }

  const columns = match[1]?.split(",") ?? [];
  return columns.map((column) => column.replace(/["`\s]/g, ""));
}

export function parseUpdateSetColumns(
  query: string,
  tableName: string,
): string[] {
  const match = query.match(
    new RegExp(`update\\s+"?${tableName}"?\\s+set\\s+(.+?)\\s+where`, "i"),
  );
  if (!match) {
    return [];
  }

  const assignments = match[1]?.split(",") ?? [];
  return assignments
    .map((assignment) => assignment.split("=")[0] ?? "")
    .map((column) => column.replace(/["`\s]/g, ""))
    .filter((column) => column.length > 0);
}

export function extractWhereClause(query: string): string {
  const normalized = query.toLowerCase();
  const whereIndex = normalized.indexOf(" where ");
  if (whereIndex < 0) {
    return "";
  }

  const orderByIndex = normalized.indexOf(" order by ", whereIndex + 7);
  const limitIndex = normalized.indexOf(" limit ", whereIndex + 7);
  const endIndex =
    orderByIndex >= 0
      ? orderByIndex
      : limitIndex >= 0
        ? limitIndex
        : normalized.length;

  return normalized.slice(whereIndex, endIndex);
}

export function hasFilter(
  whereClause: string,
  column: string,
  operator = "=",
): boolean {
  const escapedColumn = column.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const escapedOperator = operator.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const quotedPattern = new RegExp(
    `"${escapedColumn}"\\s*${escapedOperator}\\s*\\?`,
  );
  const barePattern = new RegExp(
    `\\b${escapedColumn}\\b\\s*${escapedOperator}\\s*\\?`,
  );
  return quotedPattern.test(whereClause) || barePattern.test(whereClause);
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function parseWhereEqualityParams(options: {
  whereClause: string;
  params: unknown[];
}): { values: Record<string, unknown[]>; consumedParams: number } {
  const values: Record<string, unknown[]> = {};
  const pattern = /"?([a-zA-Z0-9_]+)"?\s*=\s*\?/g;
  let parameterIndex = 0;

  let match = pattern.exec(options.whereClause);
  while (match !== null) {
    const column = match[1]?.toLowerCase();
    if (!column) {
      match = pattern.exec(options.whereClause);
      continue;
    }

    const entries = values[column] ?? [];
    entries.push(options.params[parameterIndex]);
    values[column] = entries;
    parameterIndex += 1;
    match = pattern.exec(options.whereClause);
  }

  return { values, consumedParams: parameterIndex };
}

export function parseSelectedColumns(query: string): string[] {
  const normalized = query.toLowerCase();
  const selectIndex = normalized.indexOf("select ");
  const fromIndex = normalized.indexOf(" from ");
  if (selectIndex < 0 || fromIndex < 0 || fromIndex <= selectIndex) {
    return [];
  }

  const selectClause = query.slice(selectIndex + 7, fromIndex);
  return selectClause
    .split(",")
    .map((column) => column.trim())
    .map((column) => {
      const normalizedColumn = column.toLowerCase();
      if (
        normalizedColumn.includes(`"humans"."did"`) ||
        normalizedColumn.includes("humans.did")
      ) {
        return "owner_did";
      }

      if (
        normalizedColumn.includes(`"agents"."did"`) ||
        normalizedColumn.includes("agents.did")
      ) {
        return "did";
      }

      const aliasMatch = column.match(/\s+as\s+"?([a-zA-Z0-9_]+)"?\s*$/i);
      if (aliasMatch?.[1]) {
        return aliasMatch[1].toLowerCase();
      }

      const quotedMatch = column.match(/"([a-zA-Z0-9_]+)"\s*$/);
      if (quotedMatch?.[1]) {
        return quotedMatch[1].toLowerCase();
      }

      const bare =
        column
          .split(".")
          .pop()
          ?.replace(/["`\s]/g, "") ?? "";
      return bare.toLowerCase();
    })
    .filter((column) => column.length > 0);
}
