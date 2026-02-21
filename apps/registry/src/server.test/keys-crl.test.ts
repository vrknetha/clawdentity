import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
} from "@clawdentity/protocol";
import {
  generateEd25519Keypair,
  signAIT,
  verifyAIT,
  verifyCRL,
} from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeAitClaims } from "./helpers.js";

describe("GET /.well-known/claw-keys.json", () => {
  it("returns configured registry signing keys with cache headers", async () => {
    const res = await createRegistryApp().request(
      "/.well-known/claw-keys.json",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
      expectedIssuer: "https://dev.registry.clawdentity.com",
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        {
          DB: database,
          ENVIRONMENT: "local",
          BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
          BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
