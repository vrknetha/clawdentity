import {
  ADMIN_BOOTSTRAP_PATH,
  type AitClaims,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  generateEd25519Keypair,
  REQUEST_ID_HEADER,
  signAIT,
  verifyAIT,
  verifyCRL,
} from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_LIST_LIMIT } from "./agent-list.js";
import {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
} from "./agent-registration.js";
import {
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
} from "./auth/api-key-auth.js";
import { RESOLVE_RATE_LIMIT_MAX_REQUESTS } from "./rate-limit.js";
import app, { createRegistryApp } from "./server.js";

function makeAitClaims(publicKey: Uint8Array): AitClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://registry.clawdentity.dev",
    sub: makeAgentDid(generateUlid(1700100000000)),
    ownerDid: makeHumanDid(generateUlid(1700100001000)),
    name: "agent-registry-01",
    framework: "openclaw",
    description: "registry key publishing verification path",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: encodeBase64url(publicKey),
      },
    },
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
    jti: generateUlid(1700100002000),
  };
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

type FakeAgentInsertRow = Record<string, unknown>;
type FakeHumanInsertRow = Record<string, unknown>;
type FakeApiKeyInsertRow = Record<string, unknown>;
type FakeAgentUpdateRow = Record<string, unknown>;
type FakeRevocationInsertRow = Record<string, unknown>;
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
  failApiKeyInsertCount?: number;
  failBeginTransaction?: boolean;
  revocationRows?: FakeRevocationRow[];
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
  const revocationRows = [...(options.revocationRows ?? [])];
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
            updates.push({
              lastUsedAt: String(params[0] ?? ""),
              apiKeyId: String(params[1] ?? ""),
            });
            const apiKey = apiKeyRows.find(
              (row) => row.id === String(params[1]),
            );
            if (apiKey) {
              apiKey.lastUsedAt = String(params[0] ?? "");
            }
            changes = 1;
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
    agentInserts,
    agentUpdates,
    revocationInserts,
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

  it("creates an agent, defaults framework/ttl, and persists current_jti + expires_at", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentInserts } = createFakeDb([authRow]);
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();

    const res = await createRegistryApp().request(
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
    };

    expect(body.agent.name).toBe("agent-01");
    expect(body.agent.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(body.agent.ttlDays).toBe(DEFAULT_AGENT_TTL_DAYS);
    expect(body.agent.publicKey).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(body.agent.status).toBe("active");
    expect(body.ait).toEqual(expect.any(String));

    expect(agentInserts).toHaveLength(1);
    const inserted = agentInserts[0];
    expect(inserted?.owner_id).toBe("human-1");
    expect(inserted?.name).toBe("agent-01");
    expect(inserted?.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(inserted?.public_key).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(inserted?.current_jti).toBe(body.agent.currentJti);
    expect(inserted?.expires_at).toBe(body.agent.expiresAt);
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

    const res = await createRegistryApp().request(
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
