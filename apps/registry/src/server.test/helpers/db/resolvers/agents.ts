import { encodeBase64url } from "@clawdentity/protocol";
import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "../parse.js";
import type { FakeAgentRow, FakeAgentSelectRow, FakeD1Row } from "../types.js";

export function createFakePublicKey(agentId: string): string {
  const seed = agentId.length > 0 ? agentId : "agent";
  const bytes = new Uint8Array(32);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = seed.charCodeAt(index % seed.length) & 0xff;
  }

  return encodeBase64url(bytes);
}

export function getAgentSelectColumnValue(
  row: FakeAgentSelectRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "did") {
    return row.did;
  }
  if (column === "owner_id") {
    return row.owner_id;
  }
  if (column === "owner_did") {
    return row.owner_did;
  }
  if (
    column === "owner_display_name" ||
    column === "ownerdisplayname" ||
    column === "display_name"
  ) {
    return row.owner_display_name;
  }
  if (column === "name") {
    return row.name;
  }
  if (column === "framework") {
    return row.framework;
  }
  if (column === "public_key") {
    return row.public_key;
  }
  if (column === "status") {
    return row.status;
  }
  if (column === "expires_at") {
    return row.expires_at;
  }
  if (column === "current_jti") {
    return row.current_jti;
  }
  if (column === "created_at") {
    return row.created_at;
  }
  if (column === "updated_at") {
    return row.updated_at;
  }
  return undefined;
}

export function resolveAgentSelectRows(options: {
  query: string;
  params: unknown[];
  authRows: FakeD1Row[];
  agentRows: FakeAgentRow[];
}): FakeAgentSelectRow[] {
  const normalizedQuery = options.query.toLowerCase();
  const whereClause = extractWhereClause(options.query);
  const equalityParams = parseWhereEqualityParams({
    whereClause,
    params: options.params,
  });
  const hasOwnerFilter = hasFilter(whereClause, "owner_id");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasFrameworkFilter = hasFilter(whereClause, "framework");
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasDidFilter = hasFilter(whereClause, "did");
  const hasCurrentJtiFilter = hasFilter(whereClause, "current_jti");
  const hasCursorFilter = hasFilter(whereClause, "id", "<");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");
  const requiresHumanJoin =
    normalizedQuery.includes('join "humans"') ||
    normalizedQuery.includes("join humans");

  const ownerId =
    hasOwnerFilter && typeof equalityParams.values.owner_id?.[0] === "string"
      ? String(equalityParams.values.owner_id?.[0])
      : undefined;
  const statusFilter =
    hasStatusFilter && typeof equalityParams.values.status?.[0] === "string"
      ? String(equalityParams.values.status?.[0])
      : undefined;
  const frameworkFilter =
    hasFrameworkFilter &&
    typeof equalityParams.values.framework?.[0] === "string"
      ? String(equalityParams.values.framework?.[0])
      : undefined;
  const idFilter =
    hasIdFilter && typeof equalityParams.values.id?.[0] === "string"
      ? String(equalityParams.values.id?.[0])
      : undefined;
  const didFilter =
    hasDidFilter && typeof equalityParams.values.did?.[0] === "string"
      ? String(equalityParams.values.did?.[0])
      : undefined;
  const currentJtiFilter = hasCurrentJtiFilter
    ? (equalityParams.values.current_jti?.[0] as string | null | undefined)
    : undefined;
  const cursorFilter = hasCursorFilter
    ? String(options.params[equalityParams.consumedParams] ?? "")
    : undefined;

  const maybeLimit = hasLimitClause
    ? Number(options.params[options.params.length - 1])
    : Number.NaN;
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.agentRows.length;

  const filteredRows = options.agentRows
    .filter((row) => (ownerId ? row.ownerId === ownerId : true))
    .filter((row) => (statusFilter ? row.status === statusFilter : true))
    .filter((row) =>
      frameworkFilter ? row.framework === frameworkFilter : true,
    )
    .filter((row) => (idFilter ? row.id === idFilter : true))
    .filter((row) => (didFilter ? row.did === didFilter : true))
    .filter((row) =>
      currentJtiFilter !== undefined
        ? (row.currentJti ?? null) === currentJtiFilter
        : true,
    )
    .filter((row) => (cursorFilter ? row.id < cursorFilter : true))
    .sort((left, right) => right.id.localeCompare(left.id))
    .map((row) => {
      const ownerDid = options.authRows.find(
        (authRow) => authRow.humanId === row.ownerId,
      )?.humanDid;
      const ownerDisplayName = options.authRows.find(
        (authRow) => authRow.humanId === row.ownerId,
      )?.humanDisplayName;

      return {
        id: row.id,
        did: row.did,
        owner_id: row.ownerId,
        owner_did: ownerDid ?? "",
        owner_display_name: ownerDisplayName ?? "",
        name: row.name,
        framework: row.framework,
        public_key: row.publicKey ?? createFakePublicKey(row.id),
        status: row.status,
        expires_at: row.expiresAt,
        current_jti: row.currentJti ?? null,
        created_at: row.createdAt ?? "2026-01-01T00:00:00.000Z",
        updated_at: row.updatedAt ?? "2026-01-01T00:00:00.000Z",
      };
    })
    .filter((row) => (requiresHumanJoin ? row.owner_did.length > 0 : true))
    .slice(0, limit);

  return filteredRows;
}
