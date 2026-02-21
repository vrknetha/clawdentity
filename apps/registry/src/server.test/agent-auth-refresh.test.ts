import {
  AGENT_AUTH_REFRESH_PATH,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { generateEd25519Keypair, signAIT } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import {
  deriveRefreshTokenLookupPrefix,
  hashAgentToken,
} from "../auth/agent-auth-token.js";
import { createRegistryApp } from "../server.js";
import { createFakeDb, createSignedAgentRefreshRequest } from "./helpers.js";

describe(`POST ${AGENT_AUTH_REFRESH_PATH}`, () => {
  async function buildRefreshFixture() {
    const signer = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const refreshToken =
      "clw_rft_fixture_refresh_token_value_for_registry_tests";
    const refreshTokenHash = await hashAgentToken(refreshToken);
    const ait = await signAIT({
      claims: {
        iss: "https://dev.registry.clawdentity.com",
        sub: agentDid,
        ownerDid: makeHumanDid(generateUlid(Date.now() + 2)),
        name: "agent-refresh-01",
        framework: "openclaw",
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
        jti: aitJti,
      },
      signerKid: "reg-key-1",
      signerKeypair: signer,
    });

    return {
      signer,
      agentKeypair,
      agentId,
      agentDid,
      aitJti,
      ait,
      refreshToken,
      refreshTokenHash,
    };
  }

  it("rotates refresh credentials and returns a new agent auth bundle", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const refreshExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const {
      database,
      agentAuthSessionRows,
      agentAuthSessionUpdates,
      agentAuthEventInserts,
    } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 3),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt,
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
            accessIssuedAt: nowIso,
            accessExpiresAt: refreshExpiresAt,
            accessLastUsedAt: null,
            status: "active",
            revokedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
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
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agentAuth: {
        tokenType: string;
        accessToken: string;
        accessExpiresAt: string;
        refreshToken: string;
        refreshExpiresAt: string;
      };
    };
    expect(body.agentAuth.tokenType).toBe("Bearer");
    expect(body.agentAuth.accessToken.startsWith("clw_agt_")).toBe(true);
    expect(body.agentAuth.refreshToken.startsWith("clw_rft_")).toBe(true);
    expect(body.agentAuth.refreshToken).not.toBe(fixture.refreshToken);
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthSessionRows[0]?.refreshKeyPrefix).toBe(
      deriveRefreshTokenLookupPrefix(body.agentAuth.refreshToken),
    );
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "refreshed" }),
      ]),
    );
  });

  it("rejects refresh when session is revoked", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 4),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
            accessIssuedAt: nowIso,
            accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            accessLastUsedAt: null,
            status: "revoked",
            revokedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      },
    );

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
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
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_REVOKED");
  });

  it("marks expired refresh credentials revoked and returns expired error", async () => {
    const fixture = await buildRefreshFixture();
    const nowIso = new Date().toISOString();
    const {
      database,
      agentAuthSessionRows,
      agentAuthEventInserts,
      agentAuthSessionUpdates,
    } = createFakeDb(
      [],
      [
        {
          id: fixture.agentId,
          did: fixture.agentDid,
          ownerId: "human-1",
          name: "agent-refresh-01",
          framework: "openclaw",
          publicKey: encodeBase64url(fixture.agentKeypair.publicKey),
          status: "active",
          expiresAt: null,
          currentJti: fixture.aitJti,
        },
      ],
      {
        agentAuthSessionRows: [
          {
            id: generateUlid(Date.now() + 5),
            agentId: fixture.agentId,
            refreshKeyHash: fixture.refreshTokenHash,
            refreshKeyPrefix: deriveRefreshTokenLookupPrefix(
              fixture.refreshToken,
            ),
            refreshIssuedAt: nowIso,
            refreshExpiresAt: new Date(Date.now() - 60_000).toISOString(),
            refreshLastUsedAt: null,
            accessKeyHash: "old-access-hash",
            accessKeyPrefix: "clw_agt_old",
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
    const request = await createSignedAgentRefreshRequest({
      ait: fixture.ait,
      secretKey: fixture.agentKeypair.secretKey,
      refreshToken: fixture.refreshToken,
    });

    const response = await createRegistryApp().request(
      AGENT_AUTH_REFRESH_PATH,
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
        REGISTRY_SIGNING_KEY: encodeBase64url(fixture.signer.secretKey),
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: encodeBase64url(fixture.signer.publicKey),
            status: "active",
          },
        ]),
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_AUTH_REFRESH_EXPIRED");
    expect(agentAuthSessionRows[0]?.status).toBe("revoked");
    expect(agentAuthSessionUpdates).toHaveLength(1);
    expect(agentAuthEventInserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "revoked" }),
      ]),
    );
  });

  it("returns 429 when refresh rate limit is exceeded for the same client", async () => {
    const appInstance = createRegistryApp({
      rateLimit: {
        agentAuthRefreshMaxRequests: 2,
        agentAuthRefreshWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await appInstance.request(
        AGENT_AUTH_REFRESH_PATH,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "203.0.113.88",
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
      AGENT_AUTH_REFRESH_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.88",
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
