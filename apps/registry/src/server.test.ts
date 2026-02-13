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

function createFakeDb(rows: FakeD1Row[]) {
  const updates: Array<{ lastUsedAt: string; apiKeyId: string }> = [];

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
          return { success: true } as D1Result;
        },
      } as D1PreparedStatement;
    },
  } as D1Database;

  return { database, updates };
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
    const validToken = "clw_pat_valid-token-value";
    const validHash = await hashApiKeyToken(validToken);
    const { database } = createFakeDb([
      {
        apiKeyId: "key-1",
        keyPrefix: deriveApiKeyLookupPrefix(validToken),
        keyHash: validHash,
        apiKeyStatus: "active",
        apiKeyName: "ci",
        humanId: "human-1",
        humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        humanDisplayName: "Ravi",
        humanRole: "admin",
        humanStatus: "active",
      },
    ]);

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
    const validToken = "clw_pat_valid-token-value";
    const validHash = await hashApiKeyToken(validToken);
    const { database, updates } = createFakeDb([
      {
        apiKeyId: "key-1",
        keyPrefix: deriveApiKeyLookupPrefix(validToken),
        keyHash: validHash,
        apiKeyStatus: "active",
        apiKeyName: "ci",
        humanId: "human-1",
        humanDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        humanDisplayName: "Ravi",
        humanRole: "admin",
        humanStatus: "active",
      },
    ]);

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
