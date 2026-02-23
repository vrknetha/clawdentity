import { generateUlid, ME_API_KEYS_PATH } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
} from "../auth/api-key-auth.js";
import { createRegistryApp } from "../server.js";
import {
  createFakeDb,
  type FakeD1Row,
  makeValidPatContext,
} from "./helpers.js";

describe(`POST ${ME_API_KEYS_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "workstation" }),
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("creates key and returns plaintext token once", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, apiKeyInserts } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "workstation",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      apiKey: {
        id: string;
        name: string;
        status: "active" | "revoked";
        createdAt: string;
        lastUsedAt: string | null;
        token: string;
      };
    };
    expect(body.apiKey.name).toBe("workstation");
    expect(body.apiKey.status).toBe("active");
    expect(body.apiKey.token).toMatch(/^clw_pat_/);
    expect(body.apiKey.lastUsedAt).toBeNull();

    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.name).toBe("workstation");
    expect(apiKeyInserts[0]?.key_hash).not.toBe(body.apiKey.token);
    expect(apiKeyInserts[0]?.key_prefix).toBe(
      deriveApiKeyLookupPrefix(body.apiKey.token),
    );
  });

  it("accepts empty body and uses default key name", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, apiKeyInserts } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        method: "POST",
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

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      apiKey: {
        name: string;
        token: string;
      };
    };
    expect(body.apiKey.name).toBe("api-key");
    expect(body.apiKey.token).toMatch(/^clw_pat_/);
    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.name).toBe("api-key");
  });
});

describe(`GET ${ME_API_KEYS_PATH}`, () => {
  it("returns metadata for caller-owned keys only", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const revokedToken = "clw_pat_revoked-token-value";
    const revokedTokenHash = await hashApiKeyToken(revokedToken);
    const foreignToken = "clw_pat_foreign-token-value";
    const foreignTokenHash = await hashApiKeyToken(foreignToken);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const revokedOwnedRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000002",
      keyPrefix: deriveApiKeyLookupPrefix(revokedToken),
      keyHash: revokedTokenHash,
      apiKeyStatus: "revoked",
      apiKeyName: "old-laptop",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const foreignRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000000003",
      keyPrefix: deriveApiKeyLookupPrefix(foreignToken),
      keyHash: foreignTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "foreign",
      humanId: "human-2",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB8",
      humanDisplayName: "Ira",
      humanRole: "user",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, revokedOwnedRow, foreignRow]);

    const response = await createRegistryApp().request(
      ME_API_KEYS_PATH,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
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
    const body = (await response.json()) as {
      apiKeys: Array<{
        id: string;
        name: string;
        status: "active" | "revoked";
        createdAt: string;
        lastUsedAt: string | null;
        token?: string;
        keyHash?: string;
        keyPrefix?: string;
      }>;
    };
    expect(body.apiKeys).toEqual([
      {
        id: "01KJ0000000000000000000002",
        name: "old-laptop",
        status: "revoked",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
      },
      {
        id: "01KJ0000000000000000000001",
        name: "primary",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: expect.any(String),
      },
    ]);
    for (const apiKey of body.apiKeys) {
      expect(apiKey).not.toHaveProperty("token");
      expect(apiKey).not.toHaveProperty("keyHash");
      expect(apiKey).not.toHaveProperty("keyPrefix");
    }
  });
});

describe(`DELETE ${ME_API_KEYS_PATH}/:id`, () => {
  it("returns 400 for invalid id path", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/invalid-id`,
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

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_REVOKE_INVALID_PATH");
  });

  it("returns 404 when key is not found for owner", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/${generateUlid(1700300000000)}`,
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

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_NOT_FOUND");
  });

  it("revokes target key but keeps unrelated key active", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const rotateToken = "clw_pat_rotation-token-value";
    const rotateTokenHash = await hashApiKeyToken(rotateToken);
    const targetApiKeyId = generateUlid(1700300000000);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000001001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const revokableRow: FakeD1Row = {
      apiKeyId: targetApiKeyId,
      keyPrefix: deriveApiKeyLookupPrefix(rotateToken),
      keyHash: rotateTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "rotate-me",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, revokableRow]);
    const appInstance = createRegistryApp();

    const revokeResponse = await appInstance.request(
      `${ME_API_KEYS_PATH}/${targetApiKeyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(revokeResponse.status).toBe(204);

    const revokedAuth = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${rotateToken}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(revokedAuth.status).toBe(401);
    const revokedBody = (await revokedAuth.json()) as {
      error: { code: string };
    };
    expect(revokedBody.error.code).toBe("API_KEY_REVOKED");

    const activeAuth = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );
    expect(activeAuth.status).toBe(200);
  });

  it("returns 204 when key is already revoked", async () => {
    const authToken = "clw_pat_valid-token-value";
    const authTokenHash = await hashApiKeyToken(authToken);
    const revokedToken = "clw_pat_already-revoked-token-value";
    const revokedTokenHash = await hashApiKeyToken(revokedToken);
    const targetApiKeyId = generateUlid(1700300000100);

    const authRow: FakeD1Row = {
      apiKeyId: "01KJ0000000000000000002001",
      keyPrefix: deriveApiKeyLookupPrefix(authToken),
      keyHash: authTokenHash,
      apiKeyStatus: "active",
      apiKeyName: "primary",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const alreadyRevokedRow: FakeD1Row = {
      apiKeyId: targetApiKeyId,
      keyPrefix: deriveApiKeyLookupPrefix(revokedToken),
      keyHash: revokedTokenHash,
      apiKeyStatus: "revoked",
      apiKeyName: "already-revoked",
      humanId: "human-1",
      humanDid:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      humanDisplayName: "Ravi",
      humanRole: "admin",
      humanStatus: "active",
    };
    const { database } = createFakeDb([authRow, alreadyRevokedRow]);

    const response = await createRegistryApp().request(
      `${ME_API_KEYS_PATH}/${targetApiKeyId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(204);
  });
});
