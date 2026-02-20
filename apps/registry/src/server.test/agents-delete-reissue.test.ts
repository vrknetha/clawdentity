import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
} from "@clawdentity/protocol";
import { generateEd25519Keypair, verifyAIT } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

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
      expectedIssuer: "https://dev.registry.clawdentity.com",
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
