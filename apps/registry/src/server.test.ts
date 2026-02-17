import {
  ADMIN_BOOTSTRAP_PATH,
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_VALIDATE_PATH,
  AGENT_REGISTRATION_CHALLENGE_PATH,
  canonicalizeAgentRegistrationProof,
  encodeBase64url,
  generateUlid,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  ME_API_KEYS_PATH,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  REQUEST_ID_HEADER,
  signAIT,
  signEd25519,
  signHttpRequest,
  verifyAIT,
  verifyCRL,
} from "@clawdentity/sdk";
import { buildTestAitClaims } from "@clawdentity/sdk/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_LIST_LIMIT } from "./agent-list.js";
import {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
} from "./agent-registration.js";
import {
  deriveAccessTokenLookupPrefix,
  deriveRefreshTokenLookupPrefix,
  hashAgentToken,
} from "./auth/agent-auth-token.js";
import {
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
} from "./auth/api-key-auth.js";
import { RESOLVE_RATE_LIMIT_MAX_REQUESTS } from "./rate-limit.js";
import app, { createRegistryApp } from "./server.js";

function makeAitClaims(publicKey: Uint8Array) {
  return buildTestAitClaims({
    publicKeyX: encodeBase64url(publicKey),
    issuer: "https://registry.clawdentity.dev",
    nowSeconds: Math.floor(Date.now() / 1000),
    ttlSeconds: 3600,
    nbfSkewSeconds: 5,
    seedMs: 1_700_100_000_000,
    name: "agent-registry-01",
    framework: "openclaw",
    description: "registry key publishing verification path",
  });
}

type FakeD1Row = {
  apiKeyId: string;
  keyPrefix: string;
  keyHash: string;
  apiKeyStatus: "active" | "revoked";
  apiKeyName: string;
  humanId: string;
  humanDid: string;
  humanDisplayName: string;
  humanRole: "admin" | "user";
  humanStatus: "active" | "suspended";
};

type FakeHumanRow = {
  id: string;
  did: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "suspended";
  createdAt: string;
  updatedAt: string;
};

type FakeApiKeyRow = {
  id: string;
  humanId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

type FakeAgentAuthSessionRow = {
  id: string;
  agentId: string;
  refreshKeyHash: string;
  refreshKeyPrefix: string;
  refreshIssuedAt: string;
  refreshExpiresAt: string;
  refreshLastUsedAt: string | null;
  accessKeyHash: string;
  accessKeyPrefix: string;
  accessIssuedAt: string;
  accessExpiresAt: string;
  accessLastUsedAt: string | null;
  status: "active" | "revoked";
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FakeAgentAuthEventInsertRow = Record<string, unknown>;
type FakeAgentAuthSessionInsertRow = Record<string, unknown>;
type FakeAgentAuthSessionUpdateRow = Record<string, unknown>;
type FakeApiKeySelectRow = {
  id: string;
  human_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
};

type FakeAgentInsertRow = Record<string, unknown>;
type FakeHumanInsertRow = Record<string, unknown>;
type FakeApiKeyInsertRow = Record<string, unknown>;
type FakeAgentUpdateRow = Record<string, unknown>;
type FakeRevocationInsertRow = Record<string, unknown>;
type FakeAgentRegistrationChallengeInsertRow = Record<string, unknown>;
type FakeAgentRegistrationChallengeUpdateRow = Record<string, unknown>;
type FakeInviteInsertRow = Record<string, unknown>;
type FakeInviteUpdateRow = Record<string, unknown>;
type FakeRevocationRow = {
  id: string;
  jti: string;
  agentId: string;
  reason: string | null;
  revokedAt: string;
};
type FakeAgentRow = {
  id: string;
  did: string;
  ownerId: string;
  name: string;
  framework: string | null;
  publicKey?: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  currentJti?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
type FakeAgentRegistrationChallengeRow = {
  id: string;
  ownerId: string;
  publicKey: string;
  nonce: string;
  status: "pending" | "used";
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type FakeInviteRow = {
  id: string;
  code: string;
  createdBy: string;
  redeemedBy: string | null;
  agentId: string | null;
  expiresAt: string | null;
  createdAt: string;
};

type FakeAgentSelectRow = {
  id: string;
  did: string;
  owner_id: string;
  owner_did: string;
  name: string;
  framework: string | null;
  public_key: string;
  status: "active" | "revoked";
  expires_at: string | null;
  current_jti: string | null;
  created_at: string;
  updated_at: string;
};

type FakeDbOptions = {
  beforeFirstAgentUpdate?: (agentRows: FakeAgentRow[]) => void;
  beforeFirstAgentAuthSessionUpdate?: (
    sessionRows: FakeAgentAuthSessionRow[],
  ) => void;
  failApiKeyInsertCount?: number;
  failBeginTransaction?: boolean;
  inviteRows?: FakeInviteRow[];
  revocationRows?: FakeRevocationRow[];
  registrationChallengeRows?: FakeAgentRegistrationChallengeRow[];
  agentAuthSessionRows?: FakeAgentAuthSessionRow[];
};

type FakeCrlSelectRow = {
  id: string;
  jti: string;
  reason: string | null;
  revoked_at: string;
  agent_did: string;
  did: string;
};

function parseInsertColumns(query: string, tableName: string): string[] {
  const match = query.match(
    new RegExp(`insert\\s+into\\s+"?${tableName}"?\\s*\\(([^)]+)\\)`, "i"),
  );
  if (!match) {
    return [];
  }

  const columns = match[1]?.split(",") ?? [];
  return columns.map((column) => column.replace(/["`\s]/g, ""));
}

function parseUpdateSetColumns(query: string, tableName: string): string[] {
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

function extractWhereClause(query: string): string {
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

function hasFilter(
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function parseWhereEqualityParams(options: {
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

function parseSelectedColumns(query: string): string[] {
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

function createFakePublicKey(agentId: string): string {
  const seed = agentId.length > 0 ? agentId : "agent";
  const bytes = new Uint8Array(32);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = seed.charCodeAt(index % seed.length) & 0xff;
  }

  return encodeBase64url(bytes);
}

function getAgentSelectColumnValue(
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

function getAgentRegistrationChallengeSelectColumnValue(
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

function getHumanSelectColumnValue(row: FakeHumanRow, column: string): unknown {
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

function resolveHumanSelectRows(options: {
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

function getApiKeySelectColumnValue(
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

function resolveApiKeySelectRows(options: {
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

function getAgentAuthSessionSelectColumnValue(
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

function resolveAgentAuthSessionSelectRows(options: {
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

function resolveAgentSelectRows(options: {
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

function resolveAgentRegistrationChallengeSelectRows(options: {
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

function getInviteSelectColumnValue(
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

function resolveInviteSelectRows(options: {
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

function getCrlSelectColumnValue(
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

function resolveCrlSelectRows(options: {
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

function createFakeDb(
  rows: FakeD1Row[],
  agentRows: FakeAgentRow[] = [],
  options: FakeDbOptions = {},
) {
  const updates: Array<{ lastUsedAt: string; apiKeyId: string }> = [];
  const humanInserts: FakeHumanInsertRow[] = [];
  const apiKeyInserts: FakeApiKeyInsertRow[] = [];
  const agentInserts: FakeAgentInsertRow[] = [];
  const agentUpdates: FakeAgentUpdateRow[] = [];
  const revocationInserts: FakeRevocationInsertRow[] = [];
  const agentRegistrationChallengeInserts: FakeAgentRegistrationChallengeInsertRow[] =
    [];
  const agentRegistrationChallengeUpdates: FakeAgentRegistrationChallengeUpdateRow[] =
    [];
  const agentAuthSessionInserts: FakeAgentAuthSessionInsertRow[] = [];
  const agentAuthSessionUpdates: FakeAgentAuthSessionUpdateRow[] = [];
  const agentAuthEventInserts: FakeAgentAuthEventInsertRow[] = [];
  const inviteInserts: FakeInviteInsertRow[] = [];
  const inviteUpdates: FakeInviteUpdateRow[] = [];
  const revocationRows = [...(options.revocationRows ?? [])];
  const registrationChallengeRows = [
    ...(options.registrationChallengeRows ?? []),
  ];
  const agentAuthSessionRows = [...(options.agentAuthSessionRows ?? [])];
  const inviteRows = [...(options.inviteRows ?? [])];
  const humanRows = rows.reduce<FakeHumanRow[]>((acc, row) => {
    if (acc.some((item) => item.id === row.humanId)) {
      return acc;
    }

    acc.push({
      id: row.humanId,
      did: row.humanDid,
      displayName: row.humanDisplayName,
      role: row.humanRole,
      status: row.humanStatus,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return acc;
  }, []);
  const apiKeyRows: FakeApiKeyRow[] = rows.map((row) => ({
    id: row.apiKeyId,
    humanId: row.humanId,
    keyHash: row.keyHash,
    keyPrefix: row.keyPrefix,
    name: row.apiKeyName,
    status: row.apiKeyStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
  }));
  let beforeFirstAgentUpdateApplied = false;
  let beforeFirstAgentAuthSessionUpdateApplied = false;
  let remainingApiKeyInsertFailures = options.failApiKeyInsertCount ?? 0;

  const database: D1Database = {
    prepare(query: string) {
      let params: unknown[] = [];
      const normalizedQuery = query.toLowerCase();

      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async all() {
          if (
            normalizedQuery.includes('from "api_keys"') ||
            normalizedQuery.includes("from api_keys")
          ) {
            const requiresHumanJoin =
              normalizedQuery.includes('join "humans"') ||
              normalizedQuery.includes("join humans");

            if (requiresHumanJoin) {
              const requestedKeyPrefix =
                typeof params[0] === "string" ? params[0] : "";
              const matchingRows = apiKeyRows.filter(
                (row) => row.keyPrefix === requestedKeyPrefix,
              );

              return {
                results: matchingRows
                  .map((row) => {
                    const human = humanRows.find(
                      (humanRow) => humanRow.id === row.humanId,
                    );
                    if (!human) {
                      return undefined;
                    }

                    return {
                      api_key_id: row.id,
                      key_hash: row.keyHash,
                      api_key_status: row.status,
                      api_key_name: row.name,
                      human_id: human.id,
                      human_did: human.did,
                      human_display_name: human.displayName,
                      human_role: human.role,
                      human_status: human.status,
                    };
                  })
                  .filter(isDefined),
              };
            }

            const resultRows = resolveApiKeySelectRows({
              query,
              params,
              apiKeyRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getApiKeySelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "humans"') ||
              normalizedQuery.includes("from humans")) &&
            normalizedQuery.includes("select")
          ) {
            const resultRows = resolveHumanSelectRows({
              query,
              params,
              humanRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getHumanSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agents"') ||
              normalizedQuery.includes("from agents")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentSelectRows({
              query,
              params,
              authRows: rows,
              agentRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getAgentSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agent_registration_challenges"') ||
              normalizedQuery.includes("from agent_registration_challenges")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentRegistrationChallengeSelectRows({
              query,
              params,
              challengeRows: registrationChallengeRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] =
                      getAgentRegistrationChallengeSelectColumnValue(
                        row,
                        column,
                      );
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "agent_auth_sessions"') ||
              normalizedQuery.includes("from agent_auth_sessions")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveAgentAuthSessionSelectRows({
              query,
              params,
              sessionRows: agentAuthSessionRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getAgentAuthSessionSelectColumnValue(
                      row,
                      column,
                    );
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "invites"') ||
              normalizedQuery.includes("from invites")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            const resultRows = resolveInviteSelectRows({
              query,
              params,
              inviteRows,
            });
            const selectedColumns = parseSelectedColumns(query);

            return {
              results: resultRows.map((row) => {
                if (selectedColumns.length === 0) {
                  return row;
                }

                return selectedColumns.reduce<Record<string, unknown>>(
                  (acc, column) => {
                    acc[column] = getInviteSelectColumnValue(row, column);
                    return acc;
                  },
                  {},
                );
              }),
            };
          }
          if (
            (normalizedQuery.includes('from "revocations"') ||
              normalizedQuery.includes("from revocations")) &&
            normalizedQuery.includes("select")
          ) {
            return {
              results: resolveCrlSelectRows({
                agentRows,
                revocationRows,
              }),
            };
          }
          return { results: [] };
        },
        async raw() {
          if (
            normalizedQuery.includes('from "api_keys"') ||
            normalizedQuery.includes("from api_keys")
          ) {
            const requiresHumanJoin =
              normalizedQuery.includes('join "humans"') ||
              normalizedQuery.includes("join humans");

            if (requiresHumanJoin) {
              const requestedKeyPrefix =
                typeof params[0] === "string" ? params[0] : "";
              const matchingRows = apiKeyRows.filter(
                (row) => row.keyPrefix === requestedKeyPrefix,
              );

              return matchingRows
                .map((row) => {
                  const human = humanRows.find(
                    (humanRow) => humanRow.id === row.humanId,
                  );
                  if (!human) {
                    return undefined;
                  }

                  return [
                    row.id,
                    row.keyHash,
                    row.status,
                    row.name,
                    human.id,
                    human.did,
                    human.displayName,
                    human.role,
                    human.status,
                  ];
                })
                .filter(isDefined);
            }

            const resultRows = resolveApiKeySelectRows({
              query,
              params,
              apiKeyRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getApiKeySelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agent_auth_sessions"') ||
            normalizedQuery.includes("from agent_auth_sessions")
          ) {
            const resultRows = resolveAgentAuthSessionSelectRows({
              query,
              params,
              sessionRows: agentAuthSessionRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentAuthSessionSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "humans"') ||
            normalizedQuery.includes("from humans")
          ) {
            const resultRows = resolveHumanSelectRows({
              query,
              params,
              humanRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getHumanSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agents"') ||
            normalizedQuery.includes("from agents")
          ) {
            const resultRows = resolveAgentSelectRows({
              query,
              params,
              authRows: rows,
              agentRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "agent_registration_challenges"') ||
            normalizedQuery.includes("from agent_registration_challenges")
          ) {
            const resultRows = resolveAgentRegistrationChallengeSelectRows({
              query,
              params,
              challengeRows: registrationChallengeRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentRegistrationChallengeSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "invites"') ||
            normalizedQuery.includes("from invites")
          ) {
            const resultRows = resolveInviteSelectRows({
              query,
              params,
              inviteRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getInviteSelectColumnValue(row, column),
              ),
            );
          }
          if (
            normalizedQuery.includes('from "revocations"') ||
            normalizedQuery.includes("from revocations")
          ) {
            const resultRows = resolveCrlSelectRows({
              agentRows,
              revocationRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getCrlSelectColumnValue(row, column),
              ),
            );
          }
          return [];
        },
        async run() {
          if (
            options.failBeginTransaction &&
            normalizedQuery.trim() === "begin"
          ) {
            throw new Error("Failed query: begin");
          }

          let changes = 0;

          if (
            normalizedQuery.includes('update "api_keys"') ||
            normalizedQuery.includes("update api_keys")
          ) {
            const setColumns = parseUpdateSetColumns(query, "api_keys");
            const nextValues = setColumns.reduce<Record<string, unknown>>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            const whereClause = extractWhereClause(query);
            const whereParams = params.slice(setColumns.length);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params: whereParams,
            });
            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : undefined;
            const humanIdFilter =
              typeof equalityParams.values.human_id?.[0] === "string"
                ? String(equalityParams.values.human_id[0])
                : undefined;
            const statusFilter =
              typeof equalityParams.values.status?.[0] === "string"
                ? String(equalityParams.values.status[0])
                : undefined;

            let matchedRows = 0;
            for (const row of apiKeyRows) {
              if (idFilter && row.id !== idFilter) {
                continue;
              }
              if (humanIdFilter && row.humanId !== humanIdFilter) {
                continue;
              }
              if (statusFilter && row.status !== statusFilter) {
                continue;
              }

              matchedRows += 1;
              if (
                nextValues.status === "active" ||
                nextValues.status === "revoked"
              ) {
                row.status = nextValues.status;
              }
              if (
                typeof nextValues.last_used_at === "string" ||
                nextValues.last_used_at === null
              ) {
                row.lastUsedAt = nextValues.last_used_at;
              }
            }

            if (typeof nextValues.last_used_at === "string" && idFilter) {
              updates.push({
                lastUsedAt: nextValues.last_used_at,
                apiKeyId: idFilter,
              });
            }
            changes = matchedRows;
          }
          if (
            normalizedQuery.includes('insert into "humans"') ||
            normalizedQuery.includes("insert into humans")
          ) {
            const columns = parseInsertColumns(query, "humans");
            const row = columns.reduce<FakeHumanInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            humanInserts.push(row);

            const nextHumanId = typeof row.id === "string" ? row.id : "";
            const nextHumanDid = typeof row.did === "string" ? row.did : "";
            const conflict = humanRows.some(
              (humanRow) =>
                humanRow.id === nextHumanId || humanRow.did === nextHumanDid,
            );

            if (!conflict) {
              if (
                (row.role === "admin" || row.role === "user") &&
                (row.status === "active" || row.status === "suspended") &&
                typeof row.display_name === "string" &&
                typeof row.created_at === "string" &&
                typeof row.updated_at === "string"
              ) {
                humanRows.push({
                  id: nextHumanId,
                  did: nextHumanDid,
                  displayName: row.display_name,
                  role: row.role,
                  status: row.status,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                });
              }

              changes = 1;
            } else {
              changes = 0;
            }
          }
          if (
            normalizedQuery.includes('insert into "api_keys"') ||
            normalizedQuery.includes("insert into api_keys")
          ) {
            if (remainingApiKeyInsertFailures > 0) {
              remainingApiKeyInsertFailures -= 1;
              throw new Error("api key insert failed");
            }

            const columns = parseInsertColumns(query, "api_keys");
            const row = columns.reduce<FakeApiKeyInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            apiKeyInserts.push(row);

            if (
              typeof row.id === "string" &&
              typeof row.human_id === "string" &&
              typeof row.key_hash === "string" &&
              typeof row.key_prefix === "string" &&
              typeof row.name === "string" &&
              (row.status === "active" || row.status === "revoked") &&
              typeof row.created_at === "string"
            ) {
              apiKeyRows.push({
                id: row.id,
                humanId: row.human_id,
                keyHash: row.key_hash,
                keyPrefix: row.key_prefix,
                name: row.name,
                status: row.status,
                createdAt: row.created_at,
                lastUsedAt:
                  typeof row.last_used_at === "string"
                    ? row.last_used_at
                    : null,
              });
            }

            changes = 1;
          }
          if (
            normalizedQuery.includes('insert into "agent_auth_sessions"') ||
            normalizedQuery.includes("insert into agent_auth_sessions")
          ) {
            const columns = parseInsertColumns(query, "agent_auth_sessions");
            const row = columns.reduce<FakeAgentAuthSessionInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            agentAuthSessionInserts.push(row);

            if (
              typeof row.id === "string" &&
              typeof row.agent_id === "string" &&
              typeof row.refresh_key_hash === "string" &&
              typeof row.refresh_key_prefix === "string" &&
              typeof row.refresh_issued_at === "string" &&
              typeof row.refresh_expires_at === "string" &&
              typeof row.access_key_hash === "string" &&
              typeof row.access_key_prefix === "string" &&
              typeof row.access_issued_at === "string" &&
              typeof row.access_expires_at === "string" &&
              (row.status === "active" || row.status === "revoked") &&
              typeof row.created_at === "string" &&
              typeof row.updated_at === "string"
            ) {
              const existingIndex = agentAuthSessionRows.findIndex(
                (sessionRow) => sessionRow.agentId === row.agent_id,
              );
              const nextSession: FakeAgentAuthSessionRow = {
                id: row.id,
                agentId: row.agent_id,
                refreshKeyHash: row.refresh_key_hash,
                refreshKeyPrefix: row.refresh_key_prefix,
                refreshIssuedAt: row.refresh_issued_at,
                refreshExpiresAt: row.refresh_expires_at,
                refreshLastUsedAt:
                  typeof row.refresh_last_used_at === "string"
                    ? row.refresh_last_used_at
                    : null,
                accessKeyHash: row.access_key_hash,
                accessKeyPrefix: row.access_key_prefix,
                accessIssuedAt: row.access_issued_at,
                accessExpiresAt: row.access_expires_at,
                accessLastUsedAt:
                  typeof row.access_last_used_at === "string"
                    ? row.access_last_used_at
                    : null,
                status: row.status,
                revokedAt:
                  typeof row.revoked_at === "string" ? row.revoked_at : null,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              };
              if (existingIndex >= 0) {
                agentAuthSessionRows.splice(existingIndex, 1, nextSession);
              } else {
                agentAuthSessionRows.push(nextSession);
              }
            }

            changes = 1;
          }
          if (
            normalizedQuery.includes('insert into "agent_auth_events"') ||
            normalizedQuery.includes("insert into agent_auth_events")
          ) {
            const columns = parseInsertColumns(query, "agent_auth_events");
            const row = columns.reduce<FakeAgentAuthEventInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            agentAuthEventInserts.push(row);
            changes = 1;
          }
          if (
            normalizedQuery.includes('update "agent_auth_sessions"') ||
            normalizedQuery.includes("update agent_auth_sessions")
          ) {
            if (
              !beforeFirstAgentAuthSessionUpdateApplied &&
              options.beforeFirstAgentAuthSessionUpdate
            ) {
              options.beforeFirstAgentAuthSessionUpdate(agentAuthSessionRows);
              beforeFirstAgentAuthSessionUpdateApplied = true;
            }

            const setColumns = parseUpdateSetColumns(
              query,
              "agent_auth_sessions",
            );
            const nextValues = setColumns.reduce<Record<string, unknown>>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            const whereClause = extractWhereClause(query);
            const whereParams = params.slice(setColumns.length);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params: whereParams,
            });

            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : undefined;
            const agentIdFilter =
              typeof equalityParams.values.agent_id?.[0] === "string"
                ? String(equalityParams.values.agent_id[0])
                : undefined;
            const statusFilter =
              typeof equalityParams.values.status?.[0] === "string"
                ? String(equalityParams.values.status[0])
                : undefined;
            const refreshHashFilter =
              typeof equalityParams.values.refresh_key_hash?.[0] === "string"
                ? String(equalityParams.values.refresh_key_hash[0])
                : undefined;
            const accessHashFilter =
              typeof equalityParams.values.access_key_hash?.[0] === "string"
                ? String(equalityParams.values.access_key_hash[0])
                : undefined;

            let matchedRows = 0;
            for (const row of agentAuthSessionRows) {
              if (idFilter && row.id !== idFilter) {
                continue;
              }
              if (agentIdFilter && row.agentId !== agentIdFilter) {
                continue;
              }
              if (statusFilter && row.status !== statusFilter) {
                continue;
              }
              if (
                refreshHashFilter &&
                row.refreshKeyHash !== refreshHashFilter
              ) {
                continue;
              }
              if (accessHashFilter && row.accessKeyHash !== accessHashFilter) {
                continue;
              }

              matchedRows += 1;
              if (typeof nextValues.refresh_key_hash === "string") {
                row.refreshKeyHash = nextValues.refresh_key_hash;
              }
              if (typeof nextValues.refresh_key_prefix === "string") {
                row.refreshKeyPrefix = nextValues.refresh_key_prefix;
              }
              if (typeof nextValues.refresh_issued_at === "string") {
                row.refreshIssuedAt = nextValues.refresh_issued_at;
              }
              if (typeof nextValues.refresh_expires_at === "string") {
                row.refreshExpiresAt = nextValues.refresh_expires_at;
              }
              if (
                typeof nextValues.refresh_last_used_at === "string" ||
                nextValues.refresh_last_used_at === null
              ) {
                row.refreshLastUsedAt = nextValues.refresh_last_used_at;
              }
              if (typeof nextValues.access_key_hash === "string") {
                row.accessKeyHash = nextValues.access_key_hash;
              }
              if (typeof nextValues.access_key_prefix === "string") {
                row.accessKeyPrefix = nextValues.access_key_prefix;
              }
              if (typeof nextValues.access_issued_at === "string") {
                row.accessIssuedAt = nextValues.access_issued_at;
              }
              if (typeof nextValues.access_expires_at === "string") {
                row.accessExpiresAt = nextValues.access_expires_at;
              }
              if (
                typeof nextValues.access_last_used_at === "string" ||
                nextValues.access_last_used_at === null
              ) {
                row.accessLastUsedAt = nextValues.access_last_used_at;
              }
              if (
                nextValues.status === "active" ||
                nextValues.status === "revoked"
              ) {
                row.status = nextValues.status;
              }
              if (
                typeof nextValues.revoked_at === "string" ||
                nextValues.revoked_at === null
              ) {
                row.revokedAt = nextValues.revoked_at;
              }
              if (typeof nextValues.updated_at === "string") {
                row.updatedAt = nextValues.updated_at;
              }
            }

            agentAuthSessionUpdates.push({
              ...nextValues,
              id: idFilter,
              agent_id: agentIdFilter,
              status_where: statusFilter,
              refresh_key_hash_where: refreshHashFilter,
              access_key_hash_where: accessHashFilter,
              matched_rows: matchedRows,
            });
            changes = matchedRows;
          }
          if (
            normalizedQuery.includes('delete from "agent_auth_sessions"') ||
            normalizedQuery.includes("delete from agent_auth_sessions")
          ) {
            const whereClause = extractWhereClause(query);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params,
            });
            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : undefined;

            if (idFilter) {
              for (
                let index = agentAuthSessionRows.length - 1;
                index >= 0;
                index -= 1
              ) {
                if (agentAuthSessionRows[index]?.id === idFilter) {
                  agentAuthSessionRows.splice(index, 1);
                  changes += 1;
                }
              }
            }
          }
          if (
            normalizedQuery.includes('insert into "invites"') ||
            normalizedQuery.includes("insert into invites")
          ) {
            const columns = parseInsertColumns(query, "invites");
            const row = columns.reduce<FakeInviteInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            inviteInserts.push(row);

            if (
              typeof row.id === "string" &&
              typeof row.code === "string" &&
              typeof row.created_by === "string" &&
              typeof row.created_at === "string"
            ) {
              inviteRows.push({
                id: row.id,
                code: row.code,
                createdBy: row.created_by,
                redeemedBy:
                  typeof row.redeemed_by === "string" ? row.redeemed_by : null,
                agentId: typeof row.agent_id === "string" ? row.agent_id : null,
                expiresAt:
                  typeof row.expires_at === "string" ? row.expires_at : null,
                createdAt: row.created_at,
              });
            }

            changes = 1;
          }
          if (
            normalizedQuery.includes('update "invites"') ||
            normalizedQuery.includes("update invites")
          ) {
            const setColumns = parseUpdateSetColumns(query, "invites");
            const nextValues = setColumns.reduce<Record<string, unknown>>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            const whereClause = extractWhereClause(query);
            const whereParams = params.slice(setColumns.length);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params: whereParams,
            });

            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : undefined;
            const redeemedByFilter = hasFilter(whereClause, "redeemed_by")
              ? (equalityParams.values.redeemed_by?.[0] as
                  | string
                  | null
                  | undefined)
              : undefined;
            const requiresRedeemedByNull =
              whereClause.includes("redeemed_by") &&
              whereClause.includes("is null");

            let matchedRows = 0;
            for (const row of inviteRows) {
              if (idFilter && row.id !== idFilter) {
                continue;
              }
              if (requiresRedeemedByNull && row.redeemedBy !== null) {
                continue;
              }
              if (
                redeemedByFilter !== undefined &&
                row.redeemedBy !== redeemedByFilter
              ) {
                continue;
              }

              matchedRows += 1;
              if (
                typeof nextValues.redeemed_by === "string" ||
                nextValues.redeemed_by === null
              ) {
                row.redeemedBy = nextValues.redeemed_by;
              }
            }

            inviteUpdates.push({
              ...nextValues,
              id: idFilter,
              redeemed_by_where: redeemedByFilter,
              redeemed_by_is_null_where: requiresRedeemedByNull,
              matched_rows: matchedRows,
            });
            changes = matchedRows;
          }
          if (
            normalizedQuery.includes('delete from "humans"') ||
            normalizedQuery.includes("delete from humans")
          ) {
            const whereClause = extractWhereClause(query);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params,
            });
            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : "";

            if (idFilter.length > 0) {
              for (let index = humanRows.length - 1; index >= 0; index -= 1) {
                if (humanRows[index]?.id === idFilter) {
                  humanRows.splice(index, 1);
                  changes += 1;
                }
              }

              for (let index = apiKeyRows.length - 1; index >= 0; index -= 1) {
                if (apiKeyRows[index]?.humanId === idFilter) {
                  apiKeyRows.splice(index, 1);
                }
              }
            }
          }
          if (
            normalizedQuery.includes('insert into "agents"') ||
            normalizedQuery.includes("insert into agents")
          ) {
            const columns = parseInsertColumns(query, "agents");
            const row = columns.reduce<FakeAgentInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            agentInserts.push(row);
            changes = 1;
          }
          if (
            normalizedQuery.includes(
              'insert into "agent_registration_challenges"',
            ) ||
            normalizedQuery.includes(
              "insert into agent_registration_challenges",
            )
          ) {
            const columns = parseInsertColumns(
              query,
              "agent_registration_challenges",
            );
            const row = columns.reduce<FakeAgentRegistrationChallengeInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            agentRegistrationChallengeInserts.push(row);

            if (
              typeof row.id === "string" &&
              typeof row.owner_id === "string" &&
              typeof row.public_key === "string" &&
              typeof row.nonce === "string" &&
              (row.status === "pending" || row.status === "used") &&
              typeof row.expires_at === "string" &&
              typeof row.created_at === "string" &&
              typeof row.updated_at === "string"
            ) {
              registrationChallengeRows.push({
                id: row.id,
                ownerId: row.owner_id,
                publicKey: row.public_key,
                nonce: row.nonce,
                status: row.status,
                expiresAt: row.expires_at,
                usedAt:
                  typeof row.used_at === "string" ? String(row.used_at) : null,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              });
            }

            changes = 1;
          }
          if (
            normalizedQuery.includes(
              'update "agent_registration_challenges"',
            ) ||
            normalizedQuery.includes("update agent_registration_challenges")
          ) {
            const setColumns = parseUpdateSetColumns(
              query,
              "agent_registration_challenges",
            );
            const nextValues = setColumns.reduce<Record<string, unknown>>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            const whereClause = extractWhereClause(query);
            const whereParams = params.slice(setColumns.length);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params: whereParams,
            });
            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id[0])
                : undefined;
            const ownerFilter =
              typeof equalityParams.values.owner_id?.[0] === "string"
                ? String(equalityParams.values.owner_id[0])
                : undefined;
            const statusFilter =
              typeof equalityParams.values.status?.[0] === "string"
                ? String(equalityParams.values.status[0])
                : undefined;

            let matchedRows = 0;
            for (const row of registrationChallengeRows) {
              if (idFilter && row.id !== idFilter) {
                continue;
              }
              if (ownerFilter && row.ownerId !== ownerFilter) {
                continue;
              }
              if (statusFilter && row.status !== statusFilter) {
                continue;
              }

              matchedRows += 1;
              if (
                nextValues.status === "pending" ||
                nextValues.status === "used"
              ) {
                row.status = nextValues.status;
              }
              if (
                typeof nextValues.used_at === "string" ||
                nextValues.used_at === null
              ) {
                row.usedAt = nextValues.used_at;
              }
              if (typeof nextValues.updated_at === "string") {
                row.updatedAt = nextValues.updated_at;
              }
            }

            agentRegistrationChallengeUpdates.push({
              ...nextValues,
              id: idFilter,
              owner_id: ownerFilter,
              status_where: statusFilter,
              matched_rows: matchedRows,
            });
            changes = matchedRows;
          }
          if (
            normalizedQuery.includes('update "agents"') ||
            normalizedQuery.includes("update agents")
          ) {
            if (
              !beforeFirstAgentUpdateApplied &&
              options.beforeFirstAgentUpdate
            ) {
              options.beforeFirstAgentUpdate(agentRows);
              beforeFirstAgentUpdateApplied = true;
            }

            const setColumns = parseUpdateSetColumns(query, "agents");
            const nextValues = setColumns.reduce<Record<string, unknown>>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            const whereClause = extractWhereClause(query);
            const whereParams = params.slice(setColumns.length);
            const equalityParams = parseWhereEqualityParams({
              whereClause,
              params: whereParams,
            });
            const ownerFilter =
              typeof equalityParams.values.owner_id?.[0] === "string"
                ? String(equalityParams.values.owner_id?.[0])
                : undefined;
            const idFilter =
              typeof equalityParams.values.id?.[0] === "string"
                ? String(equalityParams.values.id?.[0])
                : undefined;
            const statusFilter =
              typeof equalityParams.values.status?.[0] === "string"
                ? String(equalityParams.values.status?.[0])
                : undefined;
            const currentJtiFilter = equalityParams.values.current_jti?.[0] as
              | string
              | null
              | undefined;

            let matchedRows = 0;

            for (const row of agentRows) {
              if (ownerFilter && row.ownerId !== ownerFilter) {
                continue;
              }
              if (idFilter && row.id !== idFilter) {
                continue;
              }
              if (
                statusFilter &&
                row.status !== (statusFilter as "active" | "revoked")
              ) {
                continue;
              }
              if (
                currentJtiFilter !== undefined &&
                (row.currentJti ?? null) !== currentJtiFilter
              ) {
                continue;
              }

              matchedRows += 1;

              if (
                nextValues.status === "active" ||
                nextValues.status === "revoked"
              ) {
                row.status = nextValues.status;
              }
              if (typeof nextValues.updated_at === "string") {
                row.updatedAt = nextValues.updated_at;
              }
              if (
                typeof nextValues.current_jti === "string" ||
                nextValues.current_jti === null
              ) {
                row.currentJti = nextValues.current_jti;
              }
              if (
                typeof nextValues.expires_at === "string" ||
                nextValues.expires_at === null
              ) {
                row.expiresAt = nextValues.expires_at;
              }
            }

            agentUpdates.push({
              ...nextValues,
              owner_id: ownerFilter,
              id: idFilter,
              status_where: statusFilter,
              current_jti_where: currentJtiFilter,
              matched_rows: matchedRows,
            });
            changes = matchedRows;
          }
          if (
            normalizedQuery.includes('insert into "revocations"') ||
            normalizedQuery.includes("insert into revocations")
          ) {
            const columns = parseInsertColumns(query, "revocations");
            const row = columns.reduce<FakeRevocationInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            revocationInserts.push(row);
            if (
              typeof row.id === "string" &&
              typeof row.jti === "string" &&
              typeof row.agent_id === "string" &&
              typeof row.revoked_at === "string"
            ) {
              revocationRows.push({
                id: row.id,
                jti: row.jti,
                agentId: row.agent_id,
                reason: typeof row.reason === "string" ? row.reason : null,
                revokedAt: row.revoked_at,
              });
            }
            changes = 1;
          }
          return { success: true, meta: { changes } } as D1Result;
        },
      } as D1PreparedStatement;
    },
  } as D1Database;

  return {
    database,
    updates,
    humanRows,
    humanInserts,
    apiKeyInserts,
    agentAuthSessionRows,
    agentAuthSessionInserts,
    agentAuthSessionUpdates,
    agentAuthEventInserts,
    agentInserts,
    agentUpdates,
    agentRegistrationChallengeInserts,
    agentRegistrationChallengeUpdates,
    inviteInserts,
    inviteUpdates,
    inviteRows,
    revocationInserts,
    registrationChallengeRows,
  };
}

function makeValidPatContext(token = "clw_pat_valid-token-value") {
  return hashApiKeyToken(token).then((tokenHash) => {
    const authRow: FakeD1Row = {
      apiKeyId: "key-1",
      keyPrefix: deriveApiKeyLookupPrefix(token),
      keyHash: tokenHash,
      apiKeyStatus: "active",
      apiKeyName: "ci",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };

    return { token, authRow };
  });
}

async function signRegistrationChallenge(options: {
  challengeId: string;
  nonce: string;
  ownerDid: string;
  publicKey: string;
  name: string;
  secretKey: Uint8Array;
  framework?: string;
  ttlDays?: number;
}): Promise<string> {
  const canonical = canonicalizeAgentRegistrationProof({
    challengeId: options.challengeId,
    nonce: options.nonce,
    ownerDid: options.ownerDid,
    publicKey: options.publicKey,
    name: options.name,
    framework: options.framework,
    ttlDays: options.ttlDays,
  });
  const signature = await signEd25519(
    new TextEncoder().encode(canonical),
    options.secretKey,
  );
  return encodeEd25519SignatureBase64url(signature);
}

async function createSignedAgentRefreshRequest(options: {
  ait: string;
  secretKey: Uint8Array;
  refreshToken: string;
  timestamp?: string;
  nonce?: string;
}): Promise<{
  body: string;
  headers: Record<string, string>;
}> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? "nonce-agent-refresh";
  const body = JSON.stringify({
    refreshToken: options.refreshToken,
  });
  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: AGENT_AUTH_REFRESH_PATH,
    timestamp,
    nonce,
    body: new TextEncoder().encode(body),
    secretKey: options.secretKey,
  });

  return {
    body,
    headers: {
      authorization: `Claw ${options.ait}`,
      "content-type": "application/json",
      ...signed.headers,
    },
  };
}

describe("GET /health", () => {
  it("returns status ok with fallback version", async () => {
    const res = await app.request(
      "/health",
      {},
      { DB: {}, ENVIRONMENT: "test" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      version: "0.0.0",
      environment: "test",
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("returns APP_VERSION when provided by runtime bindings", async () => {
    const res = await createRegistryApp().request(
      "/health",
      {},
      { DB: {}, ENVIRONMENT: "test", APP_VERSION: "sha-1234567890" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      version: "sha-1234567890",
      environment: "test",
    });
  });

  it("returns config validation error for invalid environment", async () => {
    const res = await createRegistryApp().request(
      "/health",
      {},
      { DB: {}, ENVIRONMENT: "local" },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
  });
});

describe(`POST ${ADMIN_BOOTSTRAP_PATH}`, () => {
  it("returns 503 when bootstrap secret is not configured", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_DISABLED");
    expect(body.error.message).toBe("Admin bootstrap is disabled");
  });

  it("returns 401 when bootstrap secret header is missing", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_UNAUTHORIZED");
  });

  it("returns 401 when bootstrap secret is invalid", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "wrong-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_UNAUTHORIZED");
  });

  it("returns 400 when payload is not valid JSON", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: "{not-valid-json",
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_INVALID");
  });

  it("returns 400 when payload fields are invalid", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: 123,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_INVALID");
  });

  it("returns 409 when an admin already exists", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_ALREADY_COMPLETED");
  });

  it("creates admin human and PAT token once", async () => {
    const { database, humanInserts, apiKeyInserts } = createFakeDb([]);

    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        status: string;
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
    };

    expect(body.human.id).toBe("00000000000000000000000000");
    expect(body.human.did).toBe("did:claw:human:00000000000000000000000000");
    expect(body.human.displayName).toBe("Primary Admin");
    expect(body.human.role).toBe("admin");
    expect(body.human.status).toBe("active");
    expect(body.apiKey.name).toBe("prod-admin-key");
    expect(body.apiKey.token.startsWith("clw_pat_")).toBe(true);

    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.key_prefix).toBe(
      deriveApiKeyLookupPrefix(body.apiKey.token),
    );
    expect(apiKeyInserts[0]?.key_hash).toBe(
      await hashApiKeyToken(body.apiKey.token),
    );
  });

  it("returns PAT that authenticates GET /v1/me on same app and database", async () => {
    const { database } = createFakeDb([]);
    const appInstance = createRegistryApp();

    const bootstrapResponse = await appInstance.request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(bootstrapResponse.status).toBe(201);
    const bootstrapBody = (await bootstrapResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
    };

    const meResponse = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${bootstrapBody.apiKey.token}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        apiKey: {
          id: string;
          name: string;
        };
      };
    };
    expect(meBody.human).toEqual({
      id: bootstrapBody.human.id,
      did: bootstrapBody.human.did,
      displayName: bootstrapBody.human.displayName,
      role: bootstrapBody.human.role,
      apiKey: {
        id: bootstrapBody.apiKey.id,
        name: bootstrapBody.apiKey.name,
      },
    });
  });

  it("falls back to manual mutation when transactions are unavailable", async () => {
    const { database, humanInserts, apiKeyInserts } = createFakeDb([], [], {
      failBeginTransaction: true,
    });

    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(201);
    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
  });

  it("rolls back admin insert when fallback api key insert fails", async () => {
    const { database, humanRows } = createFakeDb([], [], {
      failBeginTransaction: true,
      failApiKeyInsertCount: 1,
    });

    const firstResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(firstResponse.status).toBe(500);
    expect(humanRows).toHaveLength(0);

    const secondResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(secondResponse.status).toBe(201);
    expect(humanRows).toHaveLength(1);
  });
});

describe("GET /.well-known/claw-keys.json", () => {
  it("returns configured registry signing keys with cache headers", async () => {
    const res = await createRegistryApp().request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
    );

    const body = (await res.json()) as {
      keys: Array<{
        kid: string;
        alg: string;
        crv: string;
        x: string;
        status: string;
      }>;
    };
    expect(body.keys).toEqual([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        status: "active",
      },
    ]);
  });

  it("supports fetch-and-verify AIT flow using published keys", async () => {
    const signer = await generateEd25519Keypair();
    const claims = makeAitClaims(signer.publicKey);
    const token = await signAIT({
      claims,
      signerKid: "reg-key-1",
      signerKeypair: signer,
    });

    const keysResponse = await createRegistryApp().request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    const keysBody = (await keysResponse.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    const verifiedClaims = await verifyAIT({
      token,
      expectedIssuer: claims.iss,
      registryKeys: keysBody.keys
        .filter((key) => key.status === "active")
        .map((key) => ({
          kid: key.kid,
          jwk: {
            kty: "OKP" as const,
            crv: key.crv,
            x: key.x,
          },
        })),
    });

    expect(verifiedClaims).toEqual(claims);
  });

  it("does not verify AIT when published key status is revoked", async () => {
    const signer = await generateEd25519Keypair();
    const claims = makeAitClaims(signer.publicKey);
    const token = await signAIT({
      claims,
      signerKid: "reg-key-1",
      signerKeypair: signer,
    });

    const keysResponse = await createRegistryApp().request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "revoked",
          },
        ]),
      },
    );

    const keysBody = (await keysResponse.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    await expect(
      verifyAIT({
        token,
        expectedIssuer: claims.iss,
        registryKeys: keysBody.keys
          .filter((key) => key.status === "active")
          .map((key) => ({
            kid: key.kid,
            jwk: {
              kty: "OKP" as const,
              crv: key.crv,
              x: key.x,
            },
          })),
      }),
    ).rejects.toThrow(/kid/i);
  });
});

describe("GET /v1/crl", () => {
  it("returns signed CRL snapshot with cache headers", async () => {
    const signer = await generateEd25519Keypair();
    const appInstance = createRegistryApp();
    const signingKeyset = JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]);
    const agentIdOne = generateUlid(1700400000000);
    const agentIdTwo = generateUlid(1700400000100);
    const revocationJtiOne = generateUlid(1700400000200);
    const revocationJtiTwo = generateUlid(1700400000300);
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentIdOne,
          did: makeAgentDid(agentIdOne),
          ownerId: "human-1",
          name: "revoked-one",
          framework: "openclaw",
          status: "revoked",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: agentIdTwo,
          did: makeAgentDid(agentIdTwo),
          ownerId: "human-2",
          name: "revoked-two",
          framework: "langchain",
          status: "revoked",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      {
        revocationRows: [
          {
            id: generateUlid(1700400000400),
            jti: revocationJtiOne,
            agentId: agentIdOne,
            reason: null,
            revokedAt: "2026-02-11T10:00:00.000Z",
          },
          {
            id: generateUlid(1700400000500),
            jti: revocationJtiTwo,
            agentId: agentIdTwo,
            reason: "manual revoke",
            revokedAt: "2026-02-11T11:00:00.000Z",
          },
        ],
      },
    );

    const response = await appInstance.request(
      "/v1/crl",
      {},
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
    );
    const body = (await response.json()) as { crl: string };
    expect(body.crl).toEqual(expect.any(String));

    const keysResponse = await appInstance.request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );
    const keysBody = (await keysResponse.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    const claims = await verifyCRL({
      token: body.crl,
      expectedIssuer: "https://dev.api.clawdentity.com",
      registryKeys: keysBody.keys
        .filter((key) => key.status === "active")
        .map((key) => ({
          kid: key.kid,
          jwk: {
            kty: "OKP" as const,
            crv: key.crv,
            x: key.x,
          },
        })),
    });

    expect(claims.revocations).toHaveLength(2);
    expect(claims.revocations).toEqual(
      expect.arrayContaining([
        {
          jti: revocationJtiOne,
          agentDid: makeAgentDid(agentIdOne),
          revokedAt: Math.floor(Date.parse("2026-02-11T10:00:00.000Z") / 1000),
        },
        {
          jti: revocationJtiTwo,
          agentDid: makeAgentDid(agentIdTwo),
          reason: "manual revoke",
          revokedAt: Math.floor(Date.parse("2026-02-11T11:00:00.000Z") / 1000),
        },
      ]),
    );
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(claims.exp - claims.iat).toBe(390);
  });

  it("returns 404 when no revocations are available", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      "/v1/crl",
      {},
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("CRL_NOT_FOUND");
    expect(body.error.message).toBe("CRL snapshot is not available");
  });

  it("returns 429 when rate limit is exceeded for the same client", async () => {
    const { database } = createFakeDb([]);
    const appInstance = createRegistryApp({
      rateLimit: {
        crlMaxRequests: 2,
        crlWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await appInstance.request(
        "/v1/crl",
        {
          headers: {
            "CF-Connecting-IP": "203.0.113.77",
          },
        },
        { DB: database, ENVIRONMENT: "test" },
      );

      expect(response.status).toBe(404);
    }

    const rateLimited = await appInstance.request(
      "/v1/crl",
      {
        headers: {
          "CF-Connecting-IP": "203.0.113.77",
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 500 when CRL signing configuration is missing", async () => {
    const agentId = generateUlid(1700400000600);
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "revoked-agent",
          framework: "openclaw",
          status: "revoked",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      {
        revocationRows: [
          {
            id: generateUlid(1700400000700),
            jti: generateUlid(1700400000800),
            agentId,
            reason: null,
            revokedAt: "2026-02-11T12:00:00.000Z",
          },
        ],
      },
    );

    const response = await createRegistryApp().request(
      "/v1/crl",
      {},
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      REGISTRY_SIGNING_KEYS: expect.any(Array),
    });
  });
});

describe("GET /v1/resolve/:id", () => {
  it("returns public profile fields without requiring auth", async () => {
    const { authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700500000000);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "resolve-me",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/resolve/${agentId}`,
      {},
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      did: string;
      name: string;
      framework: string;
      status: "active" | "revoked";
      ownerDid: string;
      email?: string;
      displayName?: string;
    };
    expect(body).toEqual({
      did: makeAgentDid(agentId),
      name: "resolve-me",
      framework: "openclaw",
      status: "active",
      ownerDid: authRow.humanDid,
    });
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("displayName");
  });

  it("falls back framework to openclaw when stored framework is null", async () => {
    const { authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700500000100);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "legacy-framework-null",
          framework: null,
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/resolve/${agentId}`,
      {},
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { framework: string };
    expect(body.framework).toBe("openclaw");
  });

  it("returns 400 for invalid id path", async () => {
    const res = await createRegistryApp().request(
      "/v1/resolve/not-a-ulid",
      {},
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    };
    expect(body.error.code).toBe("AGENT_RESOLVE_INVALID_PATH");
    expect(body.error.details?.fieldErrors?.id).toEqual([
      "id must be a valid ULID",
    ]);
  });

  it("returns 404 when agent does not exist", async () => {
    const { authRow } = await makeValidPatContext();
    const missingAgentId = generateUlid(1700500000200);
    const { database } = createFakeDb([authRow], []);

    const res = await createRegistryApp().request(
      `/v1/resolve/${missingAgentId}`,
      {},
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("returns 429 when rate limit is exceeded for the same client", async () => {
    const { authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700500000300);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "rate-limited-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    );
    const appInstance = createRegistryApp();

    for (let index = 0; index < RESOLVE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      const response = await appInstance.request(
        `/v1/resolve/${agentId}`,
        {
          headers: {
            "CF-Connecting-IP": "203.0.113.10",
          },
        },
        { DB: database, ENVIRONMENT: "test" },
      );

      expect(response.status).toBe(200);
    }

    const rateLimited = await appInstance.request(
      `/v1/resolve/${agentId}`,
      {
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe("GET /v1/me", () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/me",
      {},
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 401 for invalid PAT", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/me",
      {
        headers: { Authorization: "Bearer clw_pat_invalid-token-value" },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_INVALID");
  });

  it("returns 401 when PAT contains only marker", async () => {
    const res = await createRegistryApp().request(
      "/v1/me",
      {
        headers: { Authorization: "Bearer clw_pat_" },
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_INVALID");
  });

  it("authenticates valid PAT and injects ctx.human", async () => {
    const { token: validToken, authRow } = await makeValidPatContext();
    const { database, updates } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/me",
      {
        headers: { Authorization: `Bearer ${validToken}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        apiKey: { id: string; name: string };
      };
    };
    expect(body.human).toEqual({
      id: "human-1",
      did: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      displayName: "Ravi",
      role: "admin",
      apiKey: {
        id: "key-1",
        name: "ci",
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.apiKeyId).toBe("key-1");
  });
});

describe(`POST ${INVITES_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 403 when PAT owner is not an admin", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([
      {
        ...authRow,
        humanRole: "user",
      },
    ]);

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_CREATE_FORBIDDEN");
  });

  it("returns 400 when payload is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expiresAt: "not-an-iso-date",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    };
    expect(body.error.code).toBe("INVITE_CREATE_INVALID");
    expect(body.error.details?.fieldErrors?.expiresAt).toEqual([
      "expiresAt must be a valid ISO-8601 datetime",
    ]);
  });

  it("creates invite code and persists invite row", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, inviteInserts } = createFakeDb([authRow]);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expiresAt,
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      invite: {
        id: string;
        code: string;
        createdBy: string;
        expiresAt: string | null;
        createdAt: string;
      };
    };
    expect(body.invite.code.startsWith("clw_inv_")).toBe(true);
    expect(body.invite.createdBy).toBe("human-1");
    expect(body.invite.expiresAt).toBe(expiresAt);
    expect(body.invite.createdAt).toEqual(expect.any(String));

    expect(inviteInserts).toHaveLength(1);
    expect(inviteInserts[0]?.id).toBe(body.invite.id);
    expect(inviteInserts[0]?.code).toBe(body.invite.code);
    expect(inviteInserts[0]?.created_by).toBe("human-1");
    expect(inviteInserts[0]?.expires_at).toBe(expiresAt);
  });
});

describe(`POST ${INVITES_REDEEM_PATH}`, () => {
  it("returns 400 when payload is invalid", async () => {
    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    };
    expect(body.error.code).toBe("INVITE_REDEEM_INVALID");
    expect(body.error.details?.fieldErrors?.code).toEqual(["code is required"]);
  });

  it("returns 400 when invite code does not exist", async () => {
    const { database } = createFakeDb([]);

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_missing",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_CODE_INVALID");
  });

  it("returns 400 when invite is expired", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], [], {
      inviteRows: [
        {
          id: generateUlid(1700700000000),
          code: "clw_inv_expired",
          createdBy: "human-1",
          redeemedBy: null,
          agentId: null,
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_expired",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_EXPIRED");
  });

  it("returns 409 when invite is already redeemed", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], [], {
      inviteRows: [
        {
          id: generateUlid(1700700001000),
          code: "clw_inv_redeemed",
          createdBy: "human-1",
          redeemedBy: "human-2",
          agentId: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_redeemed",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_ALREADY_USED");
  });

  it("redeems invite and returns PAT that authenticates /v1/me", async () => {
    const { authRow } = await makeValidPatContext();
    const inviteCode = "clw_inv_redeem_success";
    const { database, humanInserts, apiKeyInserts, inviteRows, inviteUpdates } =
      createFakeDb([authRow], [], {
        inviteRows: [
          {
            id: generateUlid(1700700002000),
            code: inviteCode,
            createdBy: "human-1",
            redeemedBy: null,
            agentId: null,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    const appInstance = createRegistryApp();

    const redeemResponse = await appInstance.request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Invitee Alpha",
          apiKeyName: "primary-invite-key",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(redeemResponse.status).toBe(201);
    const redeemBody = (await redeemResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: "admin" | "user";
        status: "active" | "suspended";
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
    };
    expect(redeemBody.human.displayName).toBe("Invitee Alpha");
    expect(redeemBody.human.role).toBe("user");
    expect(redeemBody.apiKey.name).toBe("primary-invite-key");
    expect(redeemBody.apiKey.token.startsWith("clw_pat_")).toBe(true);

    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.human_id).toBe(redeemBody.human.id);
    expect(inviteUpdates).toHaveLength(1);
    expect(inviteRows[0]?.redeemedBy).toBe(redeemBody.human.id);

    const meResponse = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${redeemBody.apiKey.token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      human: {
        id: string;
        displayName: string;
        role: "admin" | "user";
      };
    };
    expect(meBody.human.id).toBe(redeemBody.human.id);
    expect(meBody.human.displayName).toBe("Invitee Alpha");
    expect(meBody.human.role).toBe("user");
  });

  it("rolls back fallback mutations when api key insert fails", async () => {
    const { authRow } = await makeValidPatContext();
    const inviteCode = "clw_inv_fallback_rollback";
    const { database, humanRows, inviteRows } = createFakeDb([authRow], [], {
      failBeginTransaction: true,
      failApiKeyInsertCount: 1,
      inviteRows: [
        {
          id: generateUlid(1700700003000),
          code: inviteCode,
          createdBy: "human-1",
          redeemedBy: null,
          agentId: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const appInstance = createRegistryApp();

    const firstResponse = await appInstance.request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Fallback Invitee",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(firstResponse.status).toBe(500);
    expect(humanRows).toHaveLength(1);
    expect(inviteRows[0]?.redeemedBy).toBeNull();

    const secondResponse = await appInstance.request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Fallback Invitee",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(secondResponse.status).toBe(201);
    expect(humanRows).toHaveLength(2);
    expect(inviteRows[0]?.redeemedBy).toEqual(expect.any(String));
  });
});

describe(`POST ${ME_API_KEYS_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "workstation" }),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("creates key and returns plaintext token once", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, apiKeyInserts } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "workstation",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      apiKey: {
        id: string;
        name: string;
        status: "active" | "revoked";
        createdAt: string;
        lastUsedAt: string | null;
        token: string;
      };
    };
    expect(body.apiKey.name).toBe("workstation");
    expect(body.apiKey.status).toBe("active");
    expect(body.apiKey.token).toMatch(/^clw_pat_/);
    expect(body.apiKey.lastUsedAt).toBeNull();

    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.name).toBe("workstation");
    expect(apiKeyInserts[0]?.key_hash).not.toBe(body.apiKey.token);
    expect(apiKeyInserts[0]?.key_prefix).toBe(
      deriveApiKeyLookupPrefix(body.apiKey.token),
    );
  });

  it("accepts empty body and uses default key name", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, apiKeyInserts } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      apiKey: {
        name: string;
        token: string;
      };
    };
    expect(body.apiKey.name).toBe("api-key");
    expect(body.apiKey.token).toMatch(/^clw_pat_/);
    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.name).toBe("api-key");
  });
});

describe(`GET ${ME_API_KEYS_PATH}`, () => {
  it("returns metadata for caller-owned keys only", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const revokedToken = "clw_pat_revoked-token-value";
    const revokedTokenHash = await hashApiKeyToken(revokedToken);
    const foreignToken = "clw_pat_foreign-token-value";
    const foreignTokenHash = await hashApiKeyToken(foreignToken);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const revokedOwnedRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000002",
      keyPrefix: deriveApiKeyLookupPrefix(revokedToken),
      keyHash: revokedTokenHash,
      apiKeyStatus: "revoked",
      apiKeyName: "old-laptop",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const foreignRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000003",
      keyPrefix: deriveApiKeyLookupPrefix(foreignToken),
      keyHash: foreignTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "foreign",
      humanId: "human-2",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB8",
      humanDisplayName: "Ira",
      humanRole: "user",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, revokedOwnedRow, foreignRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiKeys: Array<{
        id: string;
        name: string;
        status: "active" | "revoked";
        createdAt: string;
        lastUsedAt: string | null;
        token?: string;
        keyHash?: string;
        keyPrefix?: string;
      }>;
    };
    expect(body.apiKeys).toEqual([
      {
        id: "01KJ0000000000000000000002",
        name: "old-laptop",
        status: "revoked",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
      },
      {
        id: "01KJ0000000000000000000001",
        name: "primary",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: expect.any(String),
      },
    ]);
    for (const apiKey of body.apiKeys) {
      expect(apiKey).not.toHaveProperty("token");
      expect(apiKey).not.toHaveProperty("keyHash");
      expect(apiKey).not.toHaveProperty("keyPrefix");
    }
  });
});

describe(`DELETE ${ME_API_KEYS_PATH}/:id`, () => {
  it("returns 400 for invalid id path", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/invalid-id`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_REVOKE_INVALID_PATH");
  });

  it("returns 404 when key is not found for owner", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/${generateUlid(1700300000000)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_NOT_FOUND");
  });

  it("revokes target key but keeps unrelated key active", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const rotateToken = "clw_pat_rotation-token-value";
    const rotateTokenHash = await hashApiKeyToken(rotateToken);
    const targetApiKeyId = generateUlid(1700300000000);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000001001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const revokableRow: FakeD1Row = {
      apiKeyId: targetApiKeyId,
      keyPrefix: deriveApiKeyLookupPrefix(rotateToken),
      keyHash: rotateTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "rotate-me",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, revokableRow]);
    const appInstance = createRegistryApp();

    const revokeResponse = await appInstance.request(
      `${ME_API_KEYS_PATH}/${targetApiKeyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(revokeResponse.status).toBe(204);

    const revokedAuth = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${rotateToken}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(revokedAuth.status).toBe(401);
    const revokedBody = (await revokedAuth.json()) as {
      error: { code: string };
    };
    expect(revokedBody.error.code).toBe("API_KEY_REVOKED");

    const activeAuth = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(activeAuth.status).toBe(200);
  });

  it("returns 204 when key is already revoked", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const revokedToken = "clw_pat_already-revoked-token-value";
    const revokedTokenHash = await hashApiKeyToken(revokedToken);
    const targetApiKeyId = generateUlid(1700300000100);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000002001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const alreadyRevokedRow: FakeD1Row = {
      apiKeyId: targetApiKeyId,
      keyPrefix: deriveApiKeyLookupPrefix(revokedToken),
      keyHash: revokedTokenHash,
      apiKeyStatus: "revoked",
      apiKeyName: "already-revoked",
      humanId: "human-1",
      humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, alreadyRevokedRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/${targetApiKeyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(response.status).toBe(204);
  });
});

describe("GET /v1/agents", () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/agents",
      {},
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns only caller-owned agents with minimal fields", async () => {
    const { token, authRow } = await makeValidPatContext();
    const ownerAgentNewId = generateUlid(1700100010000);
    const ownerAgentOldId = generateUlid(1700100005000);
    const foreignAgentId = generateUlid(1700100015000);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: ownerAgentNewId,
          did: makeAgentDid(ownerAgentNewId),
          ownerId: "human-1",
          name: "owner-agent-new",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: ownerAgentOldId,
          did: makeAgentDid(ownerAgentOldId),
          ownerId: "human-1",
          name: "owner-agent-old",
          framework: "langchain",
          status: "revoked",
          expiresAt: "2026-02-20T00:00:00.000Z",
        },
        {
          id: foreignAgentId,
          did: makeAgentDid(foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    );

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{
        id: string;
        did: string;
        name: string;
        status: "active" | "revoked";
        expires: string | null;
      }>;
      pagination: {
        limit: number;
        nextCursor: string | null;
      };
    };

    expect(body.agents).toEqual([
      {
        id: ownerAgentNewId,
        did: makeAgentDid(ownerAgentNewId),
        name: "owner-agent-new",
        status: "active",
        expires: "2026-03-01T00:00:00.000Z",
      },
      {
        id: ownerAgentOldId,
        did: makeAgentDid(ownerAgentOldId),
        name: "owner-agent-old",
        status: "revoked",
        expires: "2026-02-20T00:00:00.000Z",
      },
    ]);
    expect(body.pagination).toEqual({
      limit: DEFAULT_AGENT_LIST_LIMIT,
      nextCursor: null,
    });
    expect(body.agents[0]).not.toHaveProperty("framework");
    expect(body.agents[0]).not.toHaveProperty("ownerId");
  });

  it("applies status and framework filters", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentIdOne = generateUlid(1700100010000);
    const agentIdTwo = generateUlid(1700100011000);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentIdOne,
          did: makeAgentDid(agentIdOne),
          ownerId: "human-1",
          name: "owner-openclaw-active",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: agentIdTwo,
          did: makeAgentDid(agentIdTwo),
          ownerId: "human-1",
          name: "owner-langchain-revoked",
          framework: "langchain",
          status: "revoked",
          expiresAt: "2026-03-05T00:00:00.000Z",
        },
      ],
    );

    const statusRes = await createRegistryApp().request(
      "/v1/agents?status=revoked",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      agents: Array<{
        id: string;
        did: string;
        name: string;
        status: "active" | "revoked";
        expires: string | null;
      }>;
    };
    expect(statusBody.agents).toEqual([
      {
        id: agentIdTwo,
        did: makeAgentDid(agentIdTwo),
        name: "owner-langchain-revoked",
        status: "revoked",
        expires: "2026-03-05T00:00:00.000Z",
      },
    ]);

    const frameworkRes = await createRegistryApp().request(
      "/v1/agents?framework=openclaw",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(frameworkRes.status).toBe(200);
    const frameworkBody = (await frameworkRes.json()) as {
      agents: Array<{
        id: string;
        did: string;
        name: string;
        status: "active" | "revoked";
        expires: string | null;
      }>;
    };
    expect(frameworkBody.agents).toEqual([
      {
        id: agentIdOne,
        did: makeAgentDid(agentIdOne),
        name: "owner-openclaw-active",
        status: "active",
        expires: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });

  it("supports cursor pagination and returns nextCursor", async () => {
    const { token, authRow } = await makeValidPatContext();
    const newestId = generateUlid(1700100012000);
    const olderId = generateUlid(1700100011000);
    const oldestId = generateUlid(1700100010000);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: newestId,
          did: makeAgentDid(newestId),
          ownerId: "human-1",
          name: "newest",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: olderId,
          did: makeAgentDid(olderId),
          ownerId: "human-1",
          name: "older",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-02-28T00:00:00.000Z",
        },
        {
          id: oldestId,
          did: makeAgentDid(oldestId),
          ownerId: "human-1",
          name: "oldest",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-02-27T00:00:00.000Z",
        },
      ],
    );

    const firstPage = await createRegistryApp().request(
      "/v1/agents?limit=1",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      agents: Array<{
        id: string;
        did: string;
        name: string;
        status: "active" | "revoked";
        expires: string | null;
      }>;
      pagination: { limit: number; nextCursor: string | null };
    };
    expect(firstBody.agents).toEqual([
      {
        id: newestId,
        did: makeAgentDid(newestId),
        name: "newest",
        status: "active",
        expires: "2026-03-01T00:00:00.000Z",
      },
    ]);
    expect(firstBody.pagination).toEqual({
      limit: 1,
      nextCursor: newestId,
    });

    const secondPage = await createRegistryApp().request(
      `/v1/agents?limit=1&cursor=${newestId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(secondPage.status).toBe(200);
    const secondBody = (await secondPage.json()) as {
      agents: Array<{
        id: string;
        did: string;
        name: string;
        status: "active" | "revoked";
        expires: string | null;
      }>;
      pagination: { limit: number; nextCursor: string | null };
    };
    expect(secondBody.agents).toEqual([
      {
        id: olderId,
        did: makeAgentDid(olderId),
        name: "older",
        status: "active",
        expires: "2026-02-28T00:00:00.000Z",
      },
    ]);
    expect(secondBody.pagination).toEqual({
      limit: 1,
      nextCursor: olderId,
    });
  });

  it("returns verbose query validation errors in non-production", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/agents?status=invalid",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_LIST_INVALID_QUERY");
    expect(body.error.message).toBe("Agent list query is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      status: expect.any(Array),
    });
  });

  it("returns generic query validation errors in production", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/agents?cursor=not-a-ulid",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "production" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };
    expect(body.error.code).toBe("AGENT_LIST_INVALID_QUERY");
    expect(body.error.message).toBe("Request could not be processed");
    expect(body.error.details).toBeUndefined();
  });
});

describe("GET /v1/agents/:id/ownership", () => {
  it("returns 401 when PAT is missing", async () => {
    const agentId = generateUlid(1700100017000);
    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/ownership`,
      {},
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns ownsAgent=true when caller owns the agent", async () => {
    const { token, authRow } = await makeValidPatContext();
    const ownedAgentId = generateUlid(1700100017100);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: ownedAgentId,
          did: makeAgentDid(ownedAgentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${ownedAgentId}/ownership`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ownsAgent: boolean };
    expect(body).toEqual({ ownsAgent: true });
  });

  it("returns ownsAgent=false for non-owned or missing agent ids", async () => {
    const { token, authRow } = await makeValidPatContext();
    const foreignAgentId = generateUlid(1700100017200);
    const missingAgentId = generateUlid(1700100017300);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: foreignAgentId,
          did: makeAgentDid(foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    );

    const foreignRes = await createRegistryApp().request(
      `/v1/agents/${foreignAgentId}/ownership`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(foreignRes.status).toBe(200);
    expect((await foreignRes.json()) as { ownsAgent: boolean }).toEqual({
      ownsAgent: false,
    });

    const missingRes = await createRegistryApp().request(
      `/v1/agents/${missingAgentId}/ownership`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(missingRes.status).toBe(200);
    expect((await missingRes.json()) as { ownsAgent: boolean }).toEqual({
      ownsAgent: false,
    });
  });

  it("returns path validation errors for invalid ids", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/agents/not-a-ulid/ownership",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_OWNERSHIP_INVALID_PATH");
    expect(body.error.message).toBe("Agent ownership path is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      id: expect.any(Array),
    });
  });
});

describe("DELETE /v1/agents/:id", () => {
  it("returns 401 when PAT is missing", async () => {
    const agentId = generateUlid(1700200000000);
    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 404 when agent does not exist", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentUpdates, revocationInserts } = createFakeDb([
      authRow,
    ]);
    const agentId = generateUlid(1700200000100);

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("returns 404 when agent is owned by another human", async () => {
    const { token, authRow } = await makeValidPatContext();
    const foreignAgentId = generateUlid(1700200000200);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: foreignAgentId,
          did: makeAgentDid(foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: generateUlid(1700200000201),
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${foreignAgentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("revokes owned agent and inserts revocation record", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700200000300);
    const agentJti = generateUlid(1700200000301);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: agentJti,
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(204);
    expect(agentUpdates).toHaveLength(1);
    expect(agentUpdates[0]).toMatchObject({
      id: agentId,
      status: "revoked",
      updated_at: expect.any(String),
    });
    expect(revocationInserts).toHaveLength(1);
    expect(revocationInserts[0]).toMatchObject({
      agent_id: agentId,
      jti: agentJti,
      reason: null,
      revoked_at: expect.any(String),
    });
  });

  it("is idempotent for repeat revoke requests", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700200000400);
    const agentJti = generateUlid(1700200000401);
    const { database, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: agentJti,
        },
      ],
    );

    const first = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    const second = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(revocationInserts).toHaveLength(1);
  });

  it("returns 409 when owned agent has missing current_jti", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700200000500);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: null,
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REVOKE_INVALID_STATE");
    expect(body.error.details?.fieldErrors).toMatchObject({
      currentJti: expect.any(Array),
    });
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });
});

describe("POST /v1/agents/:id/reissue", () => {
  it("returns 401 when PAT is missing", async () => {
    const agentId = generateUlid(1700300000000);
    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 404 when agent does not exist", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentUpdates, revocationInserts } = createFakeDb([
      authRow,
    ]);
    const agentId = generateUlid(1700300000100);

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("returns 404 when agent is owned by another human", async () => {
    const { token, authRow } = await makeValidPatContext();
    const foreignAgentId = generateUlid(1700300000200);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: foreignAgentId,
          did: makeAgentDid(foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "openclaw",
          status: "active",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: generateUlid(1700300000201),
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${foreignAgentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("returns 409 when agent is revoked", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700300000300);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "revoked-agent",
          framework: "openclaw",
          status: "revoked",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: generateUlid(1700300000301),
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REISSUE_INVALID_STATE");
    expect(body.error.details?.fieldErrors).toMatchObject({
      status: expect.any(Array),
    });
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("returns 409 when owned agent has missing current_jti", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700300000400);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          status: "active",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: null,
        },
      ],
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REISSUE_INVALID_STATE");
    expect(body.error.details?.fieldErrors).toMatchObject({
      currentJti: expect.any(Array),
    });
    expect(agentUpdates).toHaveLength(0);
    expect(revocationInserts).toHaveLength(0);
  });

  it("reissues owned agent, revokes old jti, and returns verifiable AIT", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700300000500);
    const previousJti = generateUlid(1700300000501);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const signingKeyset = JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: previousJti,
        },
      ],
    );
    const appInstance = createRegistryApp();

    const res = await appInstance.request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: {
        id: string;
        did: string;
        ownerDid: string;
        name: string;
        framework: string;
        publicKey: string;
        currentJti: string;
        status: string;
        expiresAt: string;
        updatedAt: string;
      };
      ait: string;
    };
    expect(body.agent.id).toBe(agentId);
    expect(body.agent.did).toBe(makeAgentDid(agentId));
    expect(body.agent.ownerDid).toBe(authRow.humanDid);
    expect(body.agent.framework).toBe("openclaw");
    expect(body.agent.publicKey).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(body.agent.currentJti).not.toBe(previousJti);
    expect(body.agent.status).toBe("active");
    expect(body.ait).toEqual(expect.any(String));

    expect(agentUpdates).toHaveLength(1);
    expect(agentUpdates[0]).toMatchObject({
      id: agentId,
      status: "active",
      status_where: "active",
      current_jti_where: previousJti,
      matched_rows: 1,
      current_jti: body.agent.currentJti,
      expires_at: body.agent.expiresAt,
      updated_at: body.agent.updatedAt,
    });

    expect(revocationInserts).toHaveLength(1);
    expect(revocationInserts[0]).toMatchObject({
      agent_id: agentId,
      jti: previousJti,
      reason: "reissued",
      revoked_at: expect.any(String),
    });

    const keysRes = await appInstance.request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );
    const keysBody = (await keysRes.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    const claims = await verifyAIT({
      token: body.ait,
      expectedIssuer: "https://dev.api.clawdentity.com",
      registryKeys: keysBody.keys
        .filter((key) => key.status === "active")
        .map((key) => ({
          kid: key.kid,
          jwk: {
            kty: "OKP" as const,
            crv: key.crv,
            x: key.x,
          },
        })),
    });
    expect(claims.sub).toBe(body.agent.did);
    expect(claims.ownerDid).toBe(body.agent.ownerDid);
    expect(claims.name).toBe(body.agent.name);
    expect(claims.framework).toBe(body.agent.framework);
    expect(claims.cnf.jwk.x).toBe(body.agent.publicKey);
    expect(claims.jti).toBe(body.agent.currentJti);
    expect(claims.jti).not.toBe(previousJti);
  });

  it("returns 409 when guarded reissue update matches zero rows", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700300000550);
    const previousJti = generateUlid(1700300000551);
    const racedJti = generateUlid(1700300000552);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const signingKeyset = JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]);
    const { database, agentUpdates, revocationInserts } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
          currentJti: previousJti,
        },
      ],
      {
        beforeFirstAgentUpdate: (rows) => {
          if (rows[0]) {
            rows[0].currentJti = racedJti;
          }
        },
      },
    );

    const res = await createRegistryApp().request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REISSUE_INVALID_STATE");
    expect(body.error.details?.fieldErrors).toMatchObject({
      currentJti: expect.any(Array),
    });
    expect(agentUpdates).toHaveLength(1);
    expect(agentUpdates[0]).toMatchObject({
      id: agentId,
      status_where: "active",
      current_jti_where: previousJti,
      matched_rows: 0,
    });
    expect(revocationInserts).toHaveLength(0);
  });

  it("does not extend expiry when reissuing a near-expiry token", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700300000560);
    const previousJti = generateUlid(1700300000561);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const signingKeyset = JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]);
    const previousExpiresAt = new Date(
      Date.now() + 5 * 60 * 1000,
    ).toISOString();
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(agentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "openclaw",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          status: "active",
          expiresAt: previousExpiresAt,
          currentJti: previousJti,
        },
      ],
    );

    const appInstance = createRegistryApp();
    const res = await appInstance.request(
      `/v1/agents/${agentId}/reissue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agent: {
        expiresAt: string;
      };
      ait: string;
    };
    expect(Date.parse(body.agent.expiresAt)).toBeLessThanOrEqual(
      Date.parse(previousExpiresAt),
    );

    const claims = await verifyAIT({
      token: body.ait,
      expectedIssuer: "https://dev.api.clawdentity.com",
      registryKeys: [
        {
          kid: "reg-key-1",
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
          },
        },
      ],
    });
    expect(claims.exp).toBeLessThanOrEqual(
      Math.floor(Date.parse(previousExpiresAt) / 1000),
    );
    expect(claims.exp).toBe(
      Math.floor(Date.parse(body.agent.expiresAt) / 1000),
    );
  });
});

describe(`POST ${AGENT_REGISTRATION_CHALLENGE_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        }),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 400 when payload is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: "not-base64url",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_INVALID");
    expect(body.error.details?.fieldErrors).toMatchObject({
      publicKey: expect.any(Array),
    });
  });

  it("creates and persists challenge for authenticated owner", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentRegistrationChallengeInserts } = createFakeDb([
      authRow,
    ]);
    const agentKeypair = await generateEd25519Keypair();

    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: encodeBase64url(agentKeypair.publicKey),
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      challengeId: string;
      nonce: string;
      ownerDid: string;
      expiresAt: string;
      algorithm: string;
      messageTemplate: string;
    };
    expect(body.challengeId).toEqual(expect.any(String));
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.ownerDid).toBe(authRow.humanDid);
    expect(body.algorithm).toBe("Ed25519");
    expect(body.messageTemplate).toContain("challengeId:{challengeId}");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    expect(agentRegistrationChallengeInserts).toHaveLength(1);
    expect(agentRegistrationChallengeInserts[0]).toMatchObject({
      id: body.challengeId,
      owner_id: "human-1",
      public_key: encodeBase64url(agentKeypair.publicKey),
      nonce: body.nonce,
      status: "pending",
      used_at: null,
    });
  });
});

describe("POST /v1/agents", () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "agent-01",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        }),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 400 when request payload is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "!!!",
          framework: "",
          publicKey: "not-base64url",
          ttlDays: 0,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_INVALID");
    expect(body.error.message).toBe("Agent registration payload is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      name: expect.any(Array),
      framework: expect.any(Array),
      publicKey: expect.any(Array),
      ttlDays: expect.any(Array),
      challengeId: expect.any(Array),
      challengeSignature: expect.any(Array),
    });
  });

  it("returns verbose malformed-json error in test", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: '{"name":"agent-01"',
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_INVALID");
    expect(body.error.message).toBe("Request body must be valid JSON");
    expect(body.error.details).toBeUndefined();
  });

  it("returns generic malformed-json error in production", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: '{"name":"agent-01"',
      },
      {
        DB: database,
        ENVIRONMENT: "production",
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_INVALID");
    expect(body.error.message).toBe("Request could not be processed");
    expect(body.error.details).toBeUndefined();
  });

  it("returns generic validation error details in production", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "!!!",
          publicKey: "not-base64url",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "production",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_INVALID");
    expect(body.error.message).toBe("Request could not be processed");
    expect(body.error.details).toBeUndefined();
  });

  it("returns 400 when registration challenge is missing", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const challengeSignature = encodeEd25519SignatureBase64url(
      Uint8Array.from({ length: 64 }, (_, index) => index + 1),
    );

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-missing-challenge",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: generateUlid(1700000000000),
          challengeSignature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_NOT_FOUND");
  });

  it("returns 400 when challenge signature is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const challengeId = generateUlid(1700000010000);
    const challengeNonce = encodeBase64url(
      Uint8Array.from({ length: 24 }, (_, index) => index + 3),
    );
    const { database } = createFakeDb([authRow], [], {
      registrationChallengeRows: [
        {
          id: challengeId,
          ownerId: "human-1",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          nonce: challengeNonce,
          status: "pending",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          usedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const invalidSignature = await signRegistrationChallenge({
      challengeId,
      nonce: challengeNonce,
      ownerDid: authRow.humanDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "wrong-name",
      secretKey: agentKeypair.secretKey,
    });

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-proof-invalid",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId,
          challengeSignature: invalidSignature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_PROOF_INVALID");
  });

  it("returns 400 when challenge has already been used", async () => {
    const { token, authRow } = await makeValidPatContext();
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const challengeId = generateUlid(1700000011000);
    const challengeNonce = encodeBase64url(
      Uint8Array.from({ length: 24 }, (_, index) => index + 5),
    );
    const { database } = createFakeDb([authRow], [], {
      registrationChallengeRows: [
        {
          id: challengeId,
          ownerId: "human-1",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          nonce: challengeNonce,
          status: "used",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          usedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const signature = await signRegistrationChallenge({
      challengeId,
      nonce: challengeNonce,
      ownerDid: authRow.humanDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-challenge-replayed",
      secretKey: agentKeypair.secretKey,
    });

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-challenge-replayed",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId,
          challengeSignature: signature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_REPLAYED");
  });

  it("creates an agent, defaults framework/ttl, and persists current_jti + expires_at", async () => {
    const { token, authRow } = await makeValidPatContext();
    const {
      database,
      agentInserts,
      agentAuthSessionInserts,
      agentAuthEventInserts,
    } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const challengeResponse = await appInstance.request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: encodeBase64url(agentKeypair.publicKey),
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );
    expect(challengeResponse.status).toBe(201);
    const challengeBody = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
      ownerDid: string;
    };
    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-01",
      secretKey: agentKeypair.secretKey,
    });

    const res = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-01",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: {
        id: string;
        did: string;
        ownerDid: string;
        name: string;
        framework: string;
        publicKey: string;
        currentJti: string;
        ttlDays: number;
        status: string;
        expiresAt: string;
        createdAt: string;
        updatedAt: string;
      };
      ait: string;
      agentAuth: {
        tokenType: string;
        accessToken: string;
        accessExpiresAt: string;
        refreshToken: string;
        refreshExpiresAt: string;
      };
    };

    expect(body.agent.name).toBe("agent-01");
    expect(body.agent.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(body.agent.ttlDays).toBe(DEFAULT_AGENT_TTL_DAYS);
    expect(body.agent.publicKey).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(body.agent.status).toBe("active");
    expect(body.ait).toEqual(expect.any(String));
    expect(body.agentAuth.tokenType).toBe("Bearer");
    expect(body.agentAuth.accessToken.startsWith("clw_agt_")).toBe(true);
    expect(body.agentAuth.refreshToken.startsWith("clw_rft_")).toBe(true);
    expect(Date.parse(body.agentAuth.accessExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(Date.parse(body.agentAuth.refreshExpiresAt)).toBeGreaterThan(
      Date.now(),
    );

    expect(agentInserts).toHaveLength(1);
    const inserted = agentInserts[0];
    expect(inserted?.owner_id).toBe("human-1");
    expect(inserted?.name).toBe("agent-01");
    expect(inserted?.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(inserted?.public_key).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(inserted?.current_jti).toBe(body.agent.currentJti);
    expect(inserted?.expires_at).toBe(body.agent.expiresAt);
    expect(agentAuthSessionInserts).toHaveLength(1);
    expect(agentAuthSessionInserts[0]).toMatchObject({
      agent_id: body.agent.id,
      status: "active",
    });
    expect(agentAuthEventInserts).toHaveLength(1);
    expect(agentAuthEventInserts[0]).toMatchObject({
      agent_id: body.agent.id,
      event_type: "issued",
    });
  });

  it("returns verifiable AIT using published keyset", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();
    const signingKeyset = JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]);

    const challengeResponse = await appInstance.request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: encodeBase64url(agentKeypair.publicKey),
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );
    expect(challengeResponse.status).toBe(201);
    const challengeBody = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
      ownerDid: string;
    };
    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-registry-verify",
      framework: "openclaw",
      ttlDays: 10,
      secretKey: agentKeypair.secretKey,
    });

    const registerResponse = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-registry-verify",
          framework: "openclaw",
          ttlDays: 10,
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );

    expect(registerResponse.status).toBe(201);
    const registerBody = (await registerResponse.json()) as {
      agent: {
        did: string;
        ownerDid: string;
        name: string;
        framework: string;
        publicKey: string;
        currentJti: string;
      };
      ait: string;
    };

    const keysResponse = await appInstance.request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: signingKeyset,
      },
    );
    const keysBody = (await keysResponse.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    const claims = await verifyAIT({
      token: registerBody.ait,
      expectedIssuer: "https://dev.api.clawdentity.com",
      registryKeys: keysBody.keys
        .filter((key) => key.status === "active")
        .map((key) => ({
          kid: key.kid,
          jwk: {
            kty: "OKP" as const,
            crv: key.crv,
            x: key.x,
          },
        })),
    });

    expect(claims.iss).toBe("https://dev.api.clawdentity.com");
    expect(claims.sub).toBe(registerBody.agent.did);
    expect(claims.ownerDid).toBe(registerBody.agent.ownerDid);
    expect(claims.name).toBe(registerBody.agent.name);
    expect(claims.framework).toBe(registerBody.agent.framework);
    expect(claims.cnf.jwk.x).toBe(registerBody.agent.publicKey);
    expect(claims.jti).toBe(registerBody.agent.currentJti);
  });

  it("returns 500 when signer secret does not match any active published key", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();
    const wrongPublishedKey = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const challengeResponse = await appInstance.request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: encodeBase64url(agentKeypair.publicKey),
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );
    expect(challengeResponse.status).toBe(201);
    const challengeBody = (await challengeResponse.json()) as {
      challengeId: string;
      nonce: string;
      ownerDid: string;
    };
    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-signer-mismatch",
      secretKey: agentKeypair.secretKey,
    });

    const res = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-signer-mismatch",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-2",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(wrongPublishedKey.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      REGISTRY_SIGNING_KEYS: expect.any(Array),
    });
  });
});

describe(`POST ${AGENT_AUTH_REFRESH_PATH}`, () => {
  async function buildRefreshFixture() {
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const refreshToken =
      "clw_rft_fixture_refresh_token_value_for_registry_tests";
    const refreshTokenHash = await hashAgentToken(refreshToken);
    const ait = await signAIT({
      claims: {
        iss: "https://dev.api.clawdentity.com",
        sub: agentDid,
        ownerDid: makeHumanDid(generateUlid(Date.now() + 2)),
        name: "agent-refresh-01",
        framework: "openclaw",
        cnf: {
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeBase64url(agentKeypair.publicKey),
          },
        },
        iat: nowSeconds - 10,
        nbf: nowSeconds - 10,
        exp: nowSeconds + 3600,
        jti: aitJti,
      },
      signerKid: "reg-key-1",
      signerKeypair: signer,
    });

    return {
      signer,
      agentKeypair,
      agentId,
      agentDid,
      aitJti,
      ait,
      refreshToken,
      refreshTokenHash,
    };
  }

  it("rotates refresh credentials and returns a new agent auth bundle", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const refreshExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const {
      database,
      agentAuthSessionRows,
      agentAuthSessionUpdates,
      agentAuthEventInserts,
    } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 3),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt,
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
            accessIssuedAt: nowIso,
            accessExpiresAt: refreshExpiresAt,
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agentAuth: {
        tokenType: string;
        accessToken: string;
        accessExpiresAt: string;
        refreshToken: string;
        refreshExpiresAt: string;
      };
    };
    expect(body.agentAuth.tokenType).toBe("Bearer");
    expect(body.agentAuth.accessToken.startsWith("clw_agt_")).toBe(true);
    expect(body.agentAuth.refreshToken.startsWith("clw_rft_")).toBe(true);
    expect(body.agentAuth.refreshToken).not.toBe(fixture.refreshToken);
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthSessionRows[0]?.refreshKeyPrefix).toBe(
      deriveRefreshTokenLookupPrefix(body.agentAuth.refreshToken),
    );
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "refreshed" }),
      ]),
    );
  });

  it("rejects refresh when session is revoked", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 4),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "revoked",
            revokedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_REVOKED");
  });

  it("marks expired refresh credentials revoked and returns expired error", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const {
      database,
      agentAuthSessionRows,
      agentAuthEventInserts,
      agentAuthSessionUpdates,
    } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 5),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() - 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_EXPIRED");
    expect(agentAuthSessionRows[0]?.status).toBe("revoked");
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "revoked" }),
      ]),
    );
  });

  it("returns 429 when refresh rate limit is exceeded for the same client", async () => {
    const appInstance = createRegistryApp({
      rateLimit: {
        agentAuthRefreshMaxRequests: 2,
        agentAuthRefreshWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await appInstance.request(
        AGENT_AUTH_REFRESH_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "203.0.113.88",
          },
          body: JSON.stringify({}),
        },
        { DB: {} as D1Database, ENVIRONMENT: "test" },
      );

      expect(response.status).toBe(400);
    }

    const rateLimited = await appInstance.request(
      AGENT_AUTH_REFRESH_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.88",
        },
        body: JSON.stringify({}),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe(`POST ${AGENT_AUTH_VALIDATE_PATH}`, () => {
  it("validates active access token and updates access_last_used_at", async () => {
    const nowIso = new Date().toISOString();
    const accessToken = "clw_agt_fixture_access_token_value_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 200);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 201);
    const { database, agentAuthSessionRows, agentAuthSessionUpdates } =
      createFakeDb(
        [],
        [
          {
            id: agentId,
            did: agentDid,
            ownerId: "human-1",
            name: "agent-access-validate-01",
            framework: "openclaw",
            publicKey: encodeBase64url(new Uint8Array(32)),
            status: "active",
            expiresAt: null,
            currentJti: aitJti,
          },
        ],
        {
          agentAuthSessionRows: [
            {
              id: generateUlid(Date.now() + 202),
              agentId,
              refreshKeyHash: "refresh-hash",
              refreshKeyPrefix: "clw_rft_fixture",
              refreshIssuedAt: nowIso,
              refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              refreshLastUsedAt: null,
              accessKeyHash: accessTokenHash,
              accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
              accessIssuedAt: nowIso,
              accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              accessLastUsedAt: null,
              status: "active",
              revokedAt: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
        },
      );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(response.status).toBe(204);
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthSessionRows[0]?.accessLastUsedAt).not.toBeNull();
  });

  it("rejects validation when x-claw-agent-access is missing", async () => {
    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentDid: makeAgentDid(generateUlid(Date.now() + 203)),
          aitJti: generateUlid(Date.now() + 204),
        }),
      },
      {
        DB: {},
        ENVIRONMENT: "test",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_UNAUTHORIZED");
  });

  it("rejects validation for expired access token", async () => {
    const nowIso = new Date().toISOString();
    const accessToken =
      "clw_agt_fixture_expired_access_token_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 205);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 206);
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "agent-access-validate-expired",
          framework: "openclaw",
          publicKey: encodeBase64url(new Uint8Array(32)),
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 207),
            agentId,
            refreshKeyHash: "refresh-hash",
            refreshKeyPrefix: "clw_rft_fixture",
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: accessTokenHash,
            accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_EXPIRED");
  });

  it("rejects validation when guarded session update matches zero rows", async () => {
    const nowIso = new Date().toISOString();
    const accessToken =
      "clw_agt_fixture_race_window_access_token_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 208);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 209);
    const { database, agentAuthSessionUpdates } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "agent-access-validate-race",
          framework: "openclaw",
          publicKey: encodeBase64url(new Uint8Array(32)),
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 210),
            agentId,
            refreshKeyHash: "refresh-hash",
            refreshKeyPrefix: "clw_rft_fixture",
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: accessTokenHash,
            accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        beforeFirstAgentAuthSessionUpdate: (rows) => {
          if (rows[0]) {
            rows[0].status = "revoked";
          }
        },
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "test",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_UNAUTHORIZED");
    expect(agentAuthSessionUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ matched_rows: 0 })]),
    );
  });

  it("returns 429 when validate rate limit is exceeded for the same client", async () => {
    const appInstance = createRegistryApp({
      rateLimit: {
        agentAuthValidateMaxRequests: 2,
        agentAuthValidateWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await appInstance.request(
        AGENT_AUTH_VALIDATE_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "203.0.113.99",
          },
          body: JSON.stringify({}),
        },
        { DB: {} as D1Database, ENVIRONMENT: "test" },
      );

      expect(response.status).toBe(400);
    }

    const rateLimited = await appInstance.request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.99",
        },
        body: JSON.stringify({}),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe("DELETE /v1/agents/:id/auth/revoke", () => {
  it("revokes active session for owned agent and is idempotent", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(Date.now() + 10);
    const nowIso = new Date().toISOString();
    const { database, agentAuthSessionRows, agentAuthEventInserts } =
      createFakeDb(
        [authRow],
        [
          {
            id: agentId,
            did: makeAgentDid(agentId),
            ownerId: authRow.humanId,
            name: "agent-auth-revoke",
            framework: "openclaw",
            publicKey: encodeBase64url(new Uint8Array(32)),
            status: "active",
            expiresAt: null,
            currentJti: generateUlid(Date.now() + 11),
          },
        ],
        {
          agentAuthSessionRows: [
            {
              id: generateUlid(Date.now() + 12),
              agentId,
              refreshKeyHash: "refresh-hash",
              refreshKeyPrefix: "clw_rft_test",
              refreshIssuedAt: nowIso,
              refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              refreshLastUsedAt: null,
              accessKeyHash: "access-hash",
              accessKeyPrefix: "clw_agt_test",
              accessIssuedAt: nowIso,
              accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              accessLastUsedAt: null,
              status: "active",
              revokedAt: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
        },
      );

    const appInstance = createRegistryApp();
    const firstResponse = await appInstance.request(
      `/v1/agents/${agentId}/auth/revoke`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(firstResponse.status).toBe(204);
    expect(agentAuthSessionRows[0]?.status).toBe("revoked");
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "revoked",
          reason: "owner_auth_revoke",
        }),
      ]),
    );

    const secondResponse = await appInstance.request(
      `/v1/agents/${agentId}/auth/revoke`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      { DB: database, ENVIRONMENT: "test" },
    );
    expect(secondResponse.status).toBe(204);
  });
});
