import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
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
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    const second = await createRegistryApp().request(
      `/v1/agents/${agentId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
