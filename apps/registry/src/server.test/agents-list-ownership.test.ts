import {
  ADMIN_INTERNAL_SERVICES_PATH,
  generateUlid,
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
  makeAgentDid,
} from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_LIST_LIMIT } from "../agent-list.js";
import {
  deriveInternalServiceSecretPrefix,
  hashInternalServiceSecret,
} from "../auth/service-auth.js";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

const DID_AUTHORITY = "dev.registry.clawdentity.com";

describe("GET /v1/agents", () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/agents",
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
          did: makeAgentDid(DID_AUTHORITY, ownerAgentNewId),
          ownerId: "human-1",
          name: "owner-agent-new",
          framework: "generic",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: ownerAgentOldId,
          did: makeAgentDid(DID_AUTHORITY, ownerAgentOldId),
          ownerId: "human-1",
          name: "owner-agent-old",
          framework: "langchain",
          status: "revoked",
          expiresAt: "2026-02-20T00:00:00.000Z",
        },
        {
          id: foreignAgentId,
          did: makeAgentDid(DID_AUTHORITY, foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "generic",
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        did: makeAgentDid(DID_AUTHORITY, ownerAgentNewId),
        name: "owner-agent-new",
        status: "active",
        expires: "2026-03-01T00:00:00.000Z",
      },
      {
        id: ownerAgentOldId,
        did: makeAgentDid(DID_AUTHORITY, ownerAgentOldId),
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
          did: makeAgentDid(DID_AUTHORITY, agentIdOne),
          ownerId: "human-1",
          name: "owner-generic-active",
          framework: "generic",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: agentIdTwo,
          did: makeAgentDid(DID_AUTHORITY, agentIdTwo),
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        did: makeAgentDid(DID_AUTHORITY, agentIdTwo),
        name: "owner-langchain-revoked",
        status: "revoked",
        expires: "2026-03-05T00:00:00.000Z",
      },
    ]);

    const frameworkRes = await createRegistryApp().request(
      "/v1/agents?framework=generic",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        did: makeAgentDid(DID_AUTHORITY, agentIdOne),
        name: "owner-generic-active",
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
          did: makeAgentDid(DID_AUTHORITY, newestId),
          ownerId: "human-1",
          name: "newest",
          framework: "generic",
          status: "active",
          expiresAt: "2026-03-01T00:00:00.000Z",
        },
        {
          id: olderId,
          did: makeAgentDid(DID_AUTHORITY, olderId),
          ownerId: "human-1",
          name: "older",
          framework: "generic",
          status: "active",
          expiresAt: "2026-02-28T00:00:00.000Z",
        },
        {
          id: oldestId,
          did: makeAgentDid(DID_AUTHORITY, oldestId),
          ownerId: "human-1",
          name: "oldest",
          framework: "generic",
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        did: makeAgentDid(DID_AUTHORITY, newestId),
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
        did: makeAgentDid(DID_AUTHORITY, olderId),
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
      {
        DB: database,
        ENVIRONMENT: "production",
        PROXY_URL: "https://proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
        EVENT_BUS_BACKEND: "memory",
        BOOTSTRAP_SECRET: "bootstrap-secret",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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

  it("returns ownsAgent=true when caller owns the agent", async () => {
    const { token, authRow } = await makeValidPatContext();
    const ownedAgentId = generateUlid(1700100017100);
    const { database } = createFakeDb(
      [authRow],
      [
        {
          id: ownedAgentId,
          did: makeAgentDid(DID_AUTHORITY, ownedAgentId),
          ownerId: "human-1",
          name: "owned-agent",
          framework: "generic",
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
          did: makeAgentDid(DID_AUTHORITY, foreignAgentId),
          ownerId: "human-2",
          name: "foreign-agent",
          framework: "generic",
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
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
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
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
    expect(body.error.code).toBe("AGENT_OWNERSHIP_INVALID_PATH");
    expect(body.error.message).toBe("Agent ownership path is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      id: expect.any(Array),
    });
  });
});

describe("internal service-auth routes", () => {
  it("returns 401 when internal service credential headers are missing", async () => {
    const res = await createRegistryApp().request(
      INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
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
    expect(body.error.code).toBe("INTERNAL_SERVICE_UNAUTHORIZED");
  });

  it("accepts local Docker authority DIDs for internal ownership checks", async () => {
    const ownerId = generateUlid(1700100010000);
    const agentId = generateUlid(1700100011000);
    const ownerDid = `did:cdi:host.docker.internal:human:${ownerId}`;
    const agentDid = `did:cdi:host.docker.internal:agent:${agentId}`;
    const serviceSecret = "clw_srv_bootstrap-test-secret";
    const { database } = createFakeDb(
      [
        {
          apiKeyId: "pat-1",
          keyPrefix: "clw_pat_test",
          keyHash: "hash-1",
          apiKeyStatus: "active",
          apiKeyName: "invite",
          humanId: ownerId,
          humanDid: ownerDid,
          humanDisplayName: "Ravi Kiran",
          humanRole: "user",
          humanStatus: "active",
        },
      ],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId,
          name: "docker-local-agent",
          framework: "generic",
          status: "active",
          expiresAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      {
        internalServiceRows: [
          {
            id: "proxy-pairing",
            name: "proxy-pairing",
            secretHash: await hashInternalServiceSecret(serviceSecret),
            secretPrefix: deriveInternalServiceSecretPrefix(serviceSecret),
            scopesJson: JSON.stringify(["identity.read"]),
            status: "active",
            createdBy: "bootstrap",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            rotatedAt: null,
            lastUsedAt: null,
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-service-id": "proxy-pairing",
          "x-claw-service-secret": serviceSecret,
        },
        body: JSON.stringify({
          ownerDid,
          agentDid,
        }),
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
      ownsAgent: boolean;
      agentStatus: "active" | "revoked" | null;
    };
    expect(body).toEqual({
      ownsAgent: true,
      agentStatus: "active",
    });
  });

  // Service-scope and payload-validation integration is covered by
  // dedicated auth + route-level tests that exercise real D1-backed flows.
  it("requires PAT auth for admin internal service endpoints", async () => {
    const res = await createRegistryApp().request(
      ADMIN_INTERNAL_SERVICES_PATH,
      {
        method: "GET",
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(401);
  });
});
