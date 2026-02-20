import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  encodeBase64url,
  generateUlid,
} from "@clawdentity/protocol";
import {
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  verifyAIT,
} from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
} from "../agent-registration.js";
import { createRegistryApp } from "../server.js";
import {
  createFakeDb,
  makeValidPatContext,
  signRegistrationChallenge,
} from "./helpers.js";

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
        PROXY_URL: "https://proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
        EVENT_BUS_BACKEND: "memory",
        BOOTSTRAP_SECRET: "bootstrap-secret",
        REGISTRY_SIGNING_KEY: "test-signing-key",
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
        PROXY_URL: "https://proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
        EVENT_BUS_BACKEND: "memory",
        BOOTSTRAP_SECRET: "bootstrap-secret",
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

    expect(claims.iss).toBe("https://dev.registry.clawdentity.com");
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
