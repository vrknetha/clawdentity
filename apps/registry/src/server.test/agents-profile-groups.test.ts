import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

const DID_AUTHORITY = "dev.registry.clawdentity.com";

describe("GET /v1/agents/profile", () => {
  it("requires authentication", async () => {
    const res = await createRegistryApp().request(
      "/v1/agents/profile?did=did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(401);
  });

  it("validates did query parameter", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], []);
    const res = await createRegistryApp().request(
      "/v1/agents/profile?did=not-a-did",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_PROFILE_INVALID_QUERY");
  });

  it("returns canonical profile fields for authenticated caller", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(1700500000400);
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
      `/v1/agents/profile?did=${encodeURIComponent(makeAgentDid(DID_AUTHORITY, agentId))}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
      agentDid: string;
      agentName: string;
      displayName: string;
      framework: string;
      status: "active" | "revoked";
      humanDid: string;
    };
    expect(body).toEqual({
      agentDid: makeAgentDid(DID_AUTHORITY, agentId),
      agentName: "resolve-me",
      displayName: authRow.humanDisplayName,
      framework: "openclaw",
      status: "active",
      humanDid: authRow.humanDid,
    });
  });

  it("returns 404 when profile agent is missing", async () => {
    const { token, authRow } = await makeValidPatContext();
    const missingDid = makeAgentDid(DID_AUTHORITY, generateUlid(1700500000500));
    const { database } = createFakeDb([authRow], []);
    const res = await createRegistryApp().request(
      `/v1/agents/profile?did=${encodeURIComponent(missingDid)}`,
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
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("GET /v1/groups/:id", () => {
  it("returns group id and name for authenticated PAT caller", async () => {
    const { token, authRow } = await makeValidPatContext();
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const { database } = createFakeDb([authRow], [], {
      groupRows: [
        {
          id: groupId,
          name: "alpha squad",
          createdBy: authRow.humanId,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });
    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}`,
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
    const body = (await res.json()) as { group: { id: string; name: string } };
    expect(body.group).toEqual({
      id: groupId,
      name: "alpha squad",
    });
  });

  it("returns 404 for missing group", async () => {
    const { token, authRow } = await makeValidPatContext();
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const { database } = createFakeDb([authRow], [], {
      groupRows: [],
    });
    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}`,
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
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GROUP_NOT_FOUND");
  });
});
