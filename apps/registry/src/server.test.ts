import {
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

type FakeAgentInsertRow = Record<string, unknown>;
type FakeAgentUpdateRow = Record<string, unknown>;
type FakeRevocationInsertRow = Record<string, unknown>;
type FakeAgentRow = {
  id: string;
  did: string;
  ownerId: string;
  name: string;
  framework: string | null;
  status: "active" | "revoked";
  expiresAt: string | null;
  currentJti?: string | null;
  updatedAt?: string;
};

type FakeAgentSelectRow = {
  id: string;
  did: string;
  name: string;
  status: "active" | "revoked";
  expires_at: string | null;
  current_jti: string | null;
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
  if (column === "name") {
    return row.name;
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
  return undefined;
}

function resolveAgentSelectRows(options: {
  query: string;
  params: unknown[];
  agentRows: FakeAgentRow[];
}): FakeAgentSelectRow[] {
  const whereClause = extractWhereClause(options.query);
  const hasOwnerFilter = hasFilter(whereClause, "owner_id");
  const hasStatusFilter = hasFilter(whereClause, "status");
  const hasFrameworkFilter = hasFilter(whereClause, "framework");
  const hasIdFilter = hasFilter(whereClause, "id");
  const hasCursorFilter = hasFilter(whereClause, "id", "<");
  const hasLimitClause = options.query.toLowerCase().includes(" limit ");

  let parameterIndex = 0;
  const ownerId = hasOwnerFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;
  if (hasOwnerFilter) {
    parameterIndex += 1;
  }

  const statusFilter = hasStatusFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;
  if (hasStatusFilter) {
    parameterIndex += 1;
  }

  const frameworkFilter = hasFrameworkFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;
  if (hasFrameworkFilter) {
    parameterIndex += 1;
  }

  const idFilter = hasIdFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;
  if (hasIdFilter) {
    parameterIndex += 1;
  }

  const cursorFilter = hasCursorFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;
  if (hasCursorFilter) {
    parameterIndex += 1;
  }

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
    .filter((row) => (cursorFilter ? row.id < cursorFilter : true))
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      did: row.did,
      name: row.name,
      status: row.status,
      expires_at: row.expiresAt,
      current_jti: row.currentJti ?? null,
    }));

  return filteredRows;
}

function createFakeDb(rows: FakeD1Row[], agentRows: FakeAgentRow[] = []) {
  const updates: Array<{ lastUsedAt: string; apiKeyId: string }> = [];
  const agentInserts: FakeAgentInsertRow[] = [];
  const agentUpdates: FakeAgentUpdateRow[] = [];
  const revocationInserts: FakeRevocationInsertRow[] = [];

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
            const matchingRows = rows.filter(
              (row) => row.keyPrefix === requestedKeyPrefix,
            );

            return {
              results: matchingRows.map((row) => ({
                api_key_id: row.apiKeyId,
                key_hash: row.keyHash,
                api_key_status: row.apiKeyStatus,
                api_key_name: row.apiKeyName,
                human_id: row.humanId,
                human_did: row.humanDid,
                human_display_name: row.humanDisplayName,
                human_role: row.humanRole,
                human_status: row.humanStatus,
              })),
            };
          }
          if (
            (normalizedQuery.includes('from "agents"') ||
              normalizedQuery.includes("from agents")) &&
            (normalizedQuery.includes("select") ||
              normalizedQuery.includes("returning"))
          ) {
            return {
              results: resolveAgentSelectRows({
                query,
                params,
                agentRows,
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
            const matchingRows = rows.filter(
              (row) => row.keyPrefix === requestedKeyPrefix,
            );

            return matchingRows.map((row) => [
              row.apiKeyId,
              row.keyHash,
              row.apiKeyStatus,
              row.apiKeyName,
              row.humanId,
              row.humanDid,
              row.humanDisplayName,
              row.humanRole,
              row.humanStatus,
            ]);
          }
          if (
            normalizedQuery.includes('from "agents"') ||
            normalizedQuery.includes("from agents")
          ) {
            const resultRows = resolveAgentSelectRows({
              query,
              params,
              agentRows,
            });
            const selectedColumns = parseSelectedColumns(query);
            return resultRows.map((row) =>
              selectedColumns.map((column) =>
                getAgentSelectColumnValue(row, column),
              ),
            );
          }
          return [];
        },
        async run() {
          if (
            normalizedQuery.includes('update "api_keys"') ||
            normalizedQuery.includes("update api_keys")
          ) {
            updates.push({
              lastUsedAt: String(params[0] ?? ""),
              apiKeyId: String(params[1] ?? ""),
            });
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
          }
          if (
            normalizedQuery.includes('update "agents"') ||
            normalizedQuery.includes("update agents")
          ) {
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
            let whereIndex = 0;
            const ownerFilter = hasFilter(whereClause, "owner_id")
              ? String(whereParams[whereIndex++] ?? "")
              : undefined;
            const idFilter = hasFilter(whereClause, "id")
              ? String(whereParams[whereIndex++] ?? "")
              : undefined;

            for (const row of agentRows) {
              if (ownerFilter && row.ownerId !== ownerFilter) {
                continue;
              }
              if (idFilter && row.id !== idFilter) {
                continue;
              }

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
            }

            agentUpdates.push({
              ...nextValues,
              owner_id: ownerFilter,
              id: idFilter,
            });
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
          }
          return { success: true } as D1Result;
        },
      } as D1PreparedStatement;
    },
  } as D1Database;

  return {
    database,
    updates,
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
  it("returns status ok", async () => {
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
