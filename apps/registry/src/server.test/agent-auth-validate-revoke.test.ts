import {
  AGENT_AUTH_VALIDATE_PATH,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
} from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  deriveAccessTokenLookupPrefix,
  hashAgentToken,
} from "../auth/agent-auth-token.js";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

describe(`POST ${AGENT_AUTH_VALIDATE_PATH}`, () => {
  it("validates active access token and updates access_last_used_at", async () => {
    const nowIso = new Date().toISOString();
    const accessToken = "clw_agt_fixture_access_token_value_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 200);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 201);
    const { database, agentAuthSessionRows, agentAuthSessionUpdates } =
      createFakeDb(
        [],
        [
          {
            id: agentId,
            did: agentDid,
            ownerId: "human-1",
            name: "agent-access-validate-01",
            framework: "openclaw",
            publicKey: encodeBase64url(new Uint8Array(32)),
            status: "active",
            expiresAt: null,
            currentJti: aitJti,
          },
        ],
        {
          agentAuthSessionRows: [
            {
              id: generateUlid(Date.now() + 202),
              agentId,
              refreshKeyHash: "refresh-hash",
              refreshKeyPrefix: "clw_rft_fixture",
              refreshIssuedAt: nowIso,
              refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              refreshLastUsedAt: null,
              accessKeyHash: accessTokenHash,
              accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
              accessIssuedAt: nowIso,
              accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              accessLastUsedAt: null,
              status: "active",
              revokedAt: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
        },
      );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(204);
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthSessionRows[0]?.accessLastUsedAt).not.toBeNull();
  });

  it("rejects validation when x-claw-agent-access is missing", async () => {
    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentDid: makeAgentDid(generateUlid(Date.now() + 203)),
          aitJti: generateUlid(Date.now() + 204),
        }),
      },
      {
        DB: {},
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_UNAUTHORIZED");
  });

  it("rejects validation for expired access token", async () => {
    const nowIso = new Date().toISOString();
    const accessToken =
      "clw_agt_fixture_expired_access_token_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 205);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 206);
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "agent-access-validate-expired",
          framework: "openclaw",
          publicKey: encodeBase64url(new Uint8Array(32)),
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 207),
            agentId,
            refreshKeyHash: "refresh-hash",
            refreshKeyPrefix: "clw_rft_fixture",
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: accessTokenHash,
            accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_EXPIRED");
  });

  it("rejects validation when guarded session update matches zero rows", async () => {
    const nowIso = new Date().toISOString();
    const accessToken =
      "clw_agt_fixture_race_window_access_token_for_registry_tests";
    const accessTokenHash = await hashAgentToken(accessToken);
    const agentId = generateUlid(Date.now() + 208);
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 209);
    const { database, agentAuthSessionUpdates } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "agent-access-validate-race",
          framework: "openclaw",
          publicKey: encodeBase64url(new Uint8Array(32)),
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 210),
            agentId,
            refreshKeyHash: "refresh-hash",
            refreshKeyPrefix: "clw_rft_fixture",
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: accessTokenHash,
            accessKeyPrefix: deriveAccessTokenLookupPrefix(accessToken),
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
        beforeFirstAgentAuthSessionUpdate: (rows) => {
          if (rows[0]) {
            rows[0].status = "revoked";
          }
        },
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": accessToken,
        },
        body: JSON.stringify({
          agentDid,
          aitJti,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_VALIDATE_UNAUTHORIZED");
    expect(agentAuthSessionUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ matched_rows: 0 })]),
    );
  });

  it("returns 429 when validate rate limit is exceeded for the same client", async () => {
    const appInstance = createRegistryApp({
      rateLimit: {
        agentAuthValidateMaxRequests: 2,
        agentAuthValidateWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await appInstance.request(
        AGENT_AUTH_VALIDATE_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "203.0.113.99",
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

      expect(response.status).toBe(400);
    }

    const rateLimited = await appInstance.request(
      AGENT_AUTH_VALIDATE_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.99",
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

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});

describe("DELETE /v1/agents/:id/auth/revoke", () => {
  it("revokes active session for owned agent and is idempotent", async () => {
    const { token, authRow } = await makeValidPatContext();
    const agentId = generateUlid(Date.now() + 10);
    const nowIso = new Date().toISOString();
    const { database, agentAuthSessionRows, agentAuthEventInserts } =
      createFakeDb(
        [authRow],
        [
          {
            id: agentId,
            did: makeAgentDid(agentId),
            ownerId: authRow.humanId,
            name: "agent-auth-revoke",
            framework: "openclaw",
            publicKey: encodeBase64url(new Uint8Array(32)),
            status: "active",
            expiresAt: null,
            currentJti: generateUlid(Date.now() + 11),
          },
        ],
        {
          agentAuthSessionRows: [
            {
              id: generateUlid(Date.now() + 12),
              agentId,
              refreshKeyHash: "refresh-hash",
              refreshKeyPrefix: "clw_rft_test",
              refreshIssuedAt: nowIso,
              refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              refreshLastUsedAt: null,
              accessKeyHash: "access-hash",
              accessKeyPrefix: "clw_agt_test",
              accessIssuedAt: nowIso,
              accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              accessLastUsedAt: null,
              status: "active",
              revokedAt: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
        },
      );

    const appInstance = createRegistryApp();
    const firstResponse = await appInstance.request(
      `/v1/agents/${agentId}/auth/revoke`,
      {
        method: "DELETE",
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
    expect(firstResponse.status).toBe(204);
    expect(agentAuthSessionRows[0]?.status).toBe("revoked");
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "revoked",
          reason: "owner_auth_revoke",
        }),
      ]),
    );

    const secondResponse = await appInstance.request(
      `/v1/agents/${agentId}/auth/revoke`,
      {
        method: "DELETE",
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
    expect(secondResponse.status).toBe(204);
  });
});
