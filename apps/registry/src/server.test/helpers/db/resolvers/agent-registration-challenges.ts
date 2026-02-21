import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeAgentRegistrationChallengeRow } from "../types.js";

export function getAgentRegistrationChallengeSelectColumnValue(
  row: FakeAgentRegistrationChallengeRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "owner_id") {
    return row.ownerId;
  }
  if (column === "public_key") {
    return row.publicKey;
  }
  if (column === "nonce") {
    return row.nonce;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "expires_at") {
    return row.expiresAt;
  }
  if (column === "used_at") {
    return row.usedAt;
  }
  if (column === "created_at") {
    return row.createdAt;
  }
  if (column === "updated_at") {
    return row.updatedAt;
  }
  return undefined;
}

export function resolveAgentRegistrationChallengeSelectRows(options: {
  query: string;
  params: unknown[];
  challengeRows: FakeAgentRegistrationChallengeRow[];
}): FakeAgentRegistrationChallengeRow[] {
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasOwnerFilter = hasFilter(whereClause, "owner_id");
  const hasChallengeIdFilter = hasFilter(whereClause, "id");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");

  const ownerId =
    hasOwnerFilter && typeof equalityParams.values.owner_id?.[0] === "string"
      ? String(equalityParams.values.owner_id[0])
      : undefined;
  const challengeId =
    hasChallengeIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id[0])
      : undefined;
  const status =
    hasStatusFilter && typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status[0])
      : undefined;

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.challengeRows.length;

  return options.challengeRows
    .filter((row) => (ownerId ? row.ownerId === ownerId : true))
    .filter((row) => (challengeId ? row.id === challengeId : true))
    .filter((row) => (status ? row.status === status : true))
    .slice(0, limit);
}
