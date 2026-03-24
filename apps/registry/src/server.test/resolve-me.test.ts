import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { RESOLVE_RATE_LIMIT_MAX_REQUESTS } from "../rate-limit.js";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

const DID_AUTHORITY = "dev.registry.clawdentity.com";

describe("GET /v1/resolve/:id", () => {
  it("returns public profile fields without requiring auth", async () => {
    const { authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700500000000);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: agentId,
          did: makeAgentDid(DID_AUTHORITY, agentId),
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      did: makeAgentDid(DID_AUTHORITY, agentId),
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
          did: makeAgentDid(DID_AUTHORITY, agentId),
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { framework: string };
    expect(body.framework).toBe("openclaw");
  });

  it("returns 400 for invalid id path", async () => {
    const res = await createRegistryApp().request(
      "/v1/resolve/not-a-ulid",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
          did: makeAgentDid(DID_AUTHORITY, agentId),
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
        {
          DB: database,
          ENVIRONMENT: "local",
          BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
          BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        },
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
});

describe("GET /v1/me", () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/me",
      {},
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

  it("returns 401 for invalid PAT", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      "/v1/me",
      {
        headers: { Authorization: "Bearer clw_pat_invalid-token-value" },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        onboardingSource: string | null;
        agentLimit: number | null;
        apiKey: { id: string; name: string };
      };
    };
    expect(body.human).toEqual({
      id: "human-1",
      did: "did:cdi:127.0.0.1:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      displayName: "Ravi",
      role: "admin",
      onboardingSource: "admin_bootstrap",
      agentLimit: null,
      apiKey: {
        id: "key-1",
        name: "ci",
      },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.apiKeyId).toBe("key-1");
  });
});
