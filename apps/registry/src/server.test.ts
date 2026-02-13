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
import { DEFAULT_AGENT_LIST_LIMIT } from "./agentList.js";
import {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
} from "./agentRegistration.js";
import {
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
} from "./auth/apiKeyAuth.js";
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
type FakeAgentRow = {
  id: string;
  did: string;
  ownerId: string;
  name: string;
  framework: string | null;
  status: "active" | "revoked";
  expiresAt: string | null;
};

type FakeAgentSelectRow = {
  id: string;
  did: string;
  name: string;
  status: "active" | "revoked";
  expires_at: string | null;
};

function parseInsertColumns(query: string): string[] {
  const match = query.match(/insert\s+into\s+"?agents"?\s*\(([^)]+)\)/i);
  if (!match) {
    return [];
  }

  const columns = match[1]?.split(",") ?? [];
  return columns.map((column) => column.replace(/["`\s]/g, ""));
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

function resolveAgentSelectRows(options: {
  query: string;
  params: unknown[];
  agentRows: FakeAgentRow[];
}): FakeAgentSelectRow[] {
  const whereClause = extractWhereClause(options.query);
  const hasStatusFilter =
    whereClause.includes("status") && whereClause.includes("= ?");
  const hasFrameworkFilter =
    whereClause.includes("framework") && whereClause.includes("= ?");
  const hasCursorFilter =
    whereClause.includes("id") && whereClause.includes("< ?");

  let parameterIndex = 0;
  const ownerId = String(options.params[parameterIndex] ?? "");
  parameterIndex += 1;

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

  const cursorFilter = hasCursorFilter
    ? String(options.params[parameterIndex] ?? "")
    : undefined;

  const maybeLimit = Number(options.params[options.params.length - 1]);
  const limit = Number.isFinite(maybeLimit)
    ? maybeLimit
    : options.agentRows.length;

  const filteredRows = options.agentRows
    .filter((row) => row.ownerId === ownerId)
    .filter((row) => (statusFilter ? row.status === statusFilter : true))
    .filter((row) =>
      frameworkFilter ? row.framework === frameworkFilter : true,
    )
    .filter((row) => (cursorFilter ? row.id < cursorFilter : true))
    .sort((left, right) => right.id.localeCompare(left.id))
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      did: row.did,
      name: row.name,
      status: row.status,
      expires_at: row.expiresAt,
    }));

  return filteredRows;
}

function createFakeDb(rows: FakeD1Row[], agentRows: FakeAgentRow[] = []) {
  const updates: Array<{ lastUsedAt: string; apiKeyId: string }> = [];
  const agentInserts: FakeAgentInsertRow[] = [];

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
            return resultRows.map((row) => [
              row.id,
              row.did,
              row.name,
              row.status,
              row.expires_at,
            ]);
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
            const columns = parseInsertColumns(query);
            const row = columns.reduce<FakeAgentInsertRow>(
              (acc, column, index) => {
                acc[column] = params[index];
                return acc;
              },
              {},
            );
            agentInserts.push(row);
          }
          return { success: true } as D1Result;
        },
      } as D1PreparedStatement;
    },
  } as D1Database;

  return { database, updates, agentInserts };
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
