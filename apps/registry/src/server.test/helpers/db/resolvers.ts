import { encodeBase64url } from "@clawdentity/protocol";
import {
  extractWhereClause,
  hasFilter,
  parseWhereEqualityParams,
} from "./parse.js";
import type {
  FakeAgentAuthSessionRow,
  FakeAgentRegistrationChallengeRow,
  FakeAgentRow,
  FakeAgentSelectRow,
  FakeApiKeyRow,
  FakeApiKeySelectRow,
  FakeCrlSelectRow,
  FakeD1Row,
  FakeHumanRow,
  FakeInviteRow,
  FakeRevocationRow,
} from "./types.js";

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

      return {
        id: row.id,
        did: row.did,
        owner_id: row.ownerId,
        owner_did: ownerDid ?? "",
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

export function getCrlSelectColumnValue(
  row: FakeCrlSelectRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "jti") {
    return row.jti;
  }
  if (column === "reason") {
    return row.reason;
  }
  if (column === "revoked_at") {
    return row.revoked_at;
  }
  if (column === "revokedat") {
    return row.revoked_at;
  }
  if (column === "agent_did") {
    return row.agent_did;
  }
  if (column === "agentdid" || column === "did") {
    return row.did;
  }
  return undefined;
}

export function resolveCrlSelectRows(options: {
  agentRows: FakeAgentRow[];
  revocationRows: FakeRevocationRow[];
}): FakeCrlSelectRow[] {
  return options.revocationRows
    .map((row) => {
      const agent = options.agentRows.find(
        (agentRow) => agentRow.id === row.agentId,
      );
      if (!agent) {
        return null;
      }

      return {
        id: row.id,
        jti: row.jti,
        reason: row.reason,
        revoked_at: row.revokedAt,
        agent_did: agent.did,
        did: agent.did,
      };
    })
    .filter((row): row is FakeCrlSelectRow => row !== null)
    .sort((left, right) => {
      const timestampCompare = right.revoked_at.localeCompare(left.revoked_at);
      if (timestampCompare !== 0) {
        return timestampCompare;
      }
      return right.id.localeCompare(left.id);
    });
}
