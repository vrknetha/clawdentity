import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  generateEd25519Keypair,
  signAIT,
  signHttpRequest,
} from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

const DID_AUTHORITY = "dev.registry.clawdentity.com";
const AGENT_AUTHORITY = "127.0.0.1";

async function buildSignedAgentGroupRequest(options: {
  method?: "GET" | "POST";
  path: string;
  agentDid: string;
  aitJti: string;
  body?: Record<string, unknown>;
}) {
  const signer = await generateEd25519Keypair();
  const agentKeypair = await generateEd25519Keypair();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = String(nowSeconds);
  const nonce = `nonce-${options.method ?? "GET"}-${Date.now()}`;
  const bodyJson = options.body ? JSON.stringify(options.body) : "";
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const ait = await signAIT({
    claims: {
      iss: "http://127.0.0.1:8788",
      sub: options.agentDid,
      ownerDid: makeHumanDid(AGENT_AUTHORITY, generateUlid(Date.now() + 10)),
      name: "group-reader",
      framework: "generic",
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: encodeBase64url(agentKeypair.publicKey),
        },
      },
      iat: nowSeconds - 10,
      nbf: nowSeconds - 10,
      exp: nowSeconds + 3600,
      jti: options.aitJti,
    },
    signerKid: "reg-key-1",
    signerKeypair: signer,
  });
  const signed = await signHttpRequest({
    method: options.method ?? "GET",
    pathWithQuery: options.path,
    timestamp,
    nonce,
    body: bodyBytes,
    secretKey: agentKeypair.secretKey,
  });

  return {
    body: bodyJson,
    headers: {
      authorization: `Claw ${ait}`,
      ...(bodyJson.length > 0 ? { "content-type": "application/json" } : {}),
      ...signed.headers,
    },
    registrySigningKey: encodeBase64url(signer.secretKey),
    registrySigningKeys: JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]),
  };
}

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
          framework: "generic",
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
      framework: "generic",
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

  it("returns 403 when PAT caller is not authorized for the group", async () => {
    const { token, authRow } = await makeValidPatContext();
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const { database } = createFakeDb([authRow], [], {
      groupRows: [
        {
          id: groupId,
          name: "alpha squad",
          createdBy: "human-unauthorized",
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
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GROUP_READ_FORBIDDEN");
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

  it("returns 404 for missing group on agent-auth requests", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHC1";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      path: `/v1/groups/${groupId}`,
      agentDid,
      aitJti,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-reader",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}`,
      {
        method: "GET",
        headers: request.headers,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GROUP_NOT_FOUND");
  });

  it("allows agent-auth group read for creator-owner without explicit membership row", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHC2";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      path: `/v1/groups/${groupId}`,
      agentDid,
      aitJti,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-reader",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [
          {
            id: groupId,
            name: "owner-readable",
            createdBy: "human-1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}`,
      {
        method: "GET",
        headers: request.headers,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { group: { id: string; name: string } };
    expect(body.group).toEqual({
      id: groupId,
      name: "owner-readable",
    });
  });
});

describe("POST /v1/groups", () => {
  it("returns 401 before payload validation when auth is missing", async () => {
    const res = await createRegistryApp().request(
      "/v1/groups",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_UNAUTHORIZED");
  });

  it("keeps PAT create behavior", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], []);
    const res = await createRegistryApp().request(
      "/v1/groups",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "research-crew",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      group: { id: string; name: string; createdByHumanId: string };
    };
    expect(body.group.name).toBe("research-crew");
    expect(body.group.createdByHumanId).toBe(authRow.humanId);
  });

  it("supports agent-auth create and stamps creator to agent owner human", async () => {
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      method: "POST",
      path: "/v1/groups",
      agentDid,
      aitJti,
      body: {
        name: "research-crew",
      },
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-creator",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
    );

    const res = await createRegistryApp().request(
      "/v1/groups",
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      group: { id: string; name: string; createdByHumanId: string };
    };
    expect(body.group.name).toBe("research-crew");
    expect(body.group.createdByHumanId).toBe("human-1");
  });
});

describe("POST /v1/groups/:id/join-tokens", () => {
  it("returns 401 before payload validation when auth is missing", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}/join-tokens`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_UNAUTHORIZED");
  });

  it("keeps PAT join-token issue behavior", async () => {
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
      `/v1/groups/${groupId}/join-tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          role: "member",
          expiresInSeconds: 3600,
          maxUses: 1,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      groupJoinToken: { groupId: string; token: string };
    };
    expect(body.groupJoinToken.groupId).toBe(groupId);
    expect(body.groupJoinToken.token.startsWith("clw_gjt_")).toBe(true);
  });

  it("supports agent-auth join-token issue for creator-owner", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      method: "POST",
      path: `/v1/groups/${groupId}/join-tokens`,
      agentDid,
      aitJti,
      body: {
        role: "member",
        expiresInSeconds: 3600,
        maxUses: 1,
      },
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-admin",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [
          {
            id: groupId,
            name: "alpha squad",
            createdBy: "human-1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}/join-tokens`,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      groupJoinToken: { groupId: string };
    };
    expect(body.groupJoinToken.groupId).toBe(groupId);
  });

  it("rejects agent-auth join-token issue when actor cannot manage group", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      method: "POST",
      path: `/v1/groups/${groupId}/join-tokens`,
      agentDid,
      aitJti,
      body: {
        role: "member",
        expiresInSeconds: 3600,
        maxUses: 1,
      },
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-2",
          name: "group-admin",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [
          {
            id: groupId,
            name: "alpha squad",
            createdBy: "human-1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}/join-tokens`,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GROUP_MANAGE_FORBIDDEN");
  });
});

describe("GET /v1/groups/:id/members", () => {
  it("supports agent-auth members list for creator-owner without member row", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      path: `/v1/groups/${groupId}/members`,
      agentDid,
      aitJti,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-reader",
          framework: "generic",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [
          {
            id: groupId,
            name: "alpha squad",
            createdBy: "human-1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}/members`,
      {
        method: "GET",
        headers: request.headers,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      group: { id: string };
      members: Array<{ agentDid: string }>;
    };
    expect(body.group.id).toBe(groupId);
    expect(Array.isArray(body.members)).toBe(true);
  });
});
