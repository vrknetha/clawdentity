import {
  ADMIN_BOOTSTRAP_PATH,
  REGISTRY_METADATA_PATH,
} from "@clawdentity/protocol";
import { REQUEST_ID_HEADER } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import {
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
} from "../auth/api-key-auth.js";
import app, { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

const TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET = "clw_srv_bootstrap-test-secret";

describe("GET /health", () => {
  it("returns status ok with fallback version", async () => {
    const res = await app.request(
      "/health",
      {},
      {
        DB: {},
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      version: "0.0.0",
      environment: "local",
      ready: false,
      readiness: {
        versionSource: "fallback",
        dbBindingConfigured: true,
      },
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("returns APP_VERSION when provided by runtime bindings", async () => {
    const res = await createRegistryApp().request(
      "/health",
      {},
      {
        DB: {},
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        APP_VERSION: "sha-1234567890",
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "ok",
      version: "sha-1234567890",
      environment: "local",
      ready: false,
      readiness: {
        versionSource: "APP_VERSION",
      },
    });
  });

  it("returns config validation error for invalid environment", async () => {
    const res = await createRegistryApp().request(
      "/health",
      {},
      {
        DB: {},
        ENVIRONMENT: "invalid",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
  });
});

describe(`GET ${REGISTRY_METADATA_PATH}`, () => {
  it("returns environment metadata including resolved proxy URL", async () => {
    const res = await createRegistryApp().request(
      `https://registry.example.test${REGISTRY_METADATA_PATH}`,
      {},
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        APP_VERSION: "sha-meta-123",
        PROXY_URL: "https://dev.proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://dev.registry.clawdentity.com",
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      environment: string;
      version: string;
      registryUrl: string;
      proxyUrl: string;
    };
    expect(body).toEqual({
      status: "ok",
      environment: "local",
      version: "sha-meta-123",
      registryUrl: "https://registry.example.test",
      proxyUrl: "https://dev.proxy.clawdentity.com",
    });
  });

  it("returns caller-facing local registry and proxy URLs when runtime uses loopback", async () => {
    const res = await createRegistryApp().request(
      `https://dev.registry.clawdentity.com${REGISTRY_METADATA_PATH}`,
      {
        headers: {
          host: "host.docker.internal:8788",
          "x-forwarded-host": "host.docker.internal:8788",
          "x-forwarded-proto": "http",
        },
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        APP_VERSION: "sha-meta-local",
        PROXY_URL: "http://127.0.0.1:8787",
        REGISTRY_ISSUER_URL: "https://dev.registry.clawdentity.com",
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registryUrl: string;
      proxyUrl: string;
    };
    expect(body.registryUrl).toBe("http://host.docker.internal:8788");
    expect(body.proxyUrl).toBe("http://host.docker.internal:8787");
  });
});

describe(`POST ${ADMIN_BOOTSTRAP_PATH}`, () => {
  it("returns 503 when bootstrap secret is not configured", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_DISABLED");
    expect(body.error.message).toBe("Admin bootstrap is disabled");
  });

  it("returns 401 when bootstrap secret header is missing", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_UNAUTHORIZED");
  });

  it("returns 401 when bootstrap secret is invalid", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "wrong-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_UNAUTHORIZED");
  });

  it("returns 400 when payload is not valid JSON", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: "{not-valid-json",
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_INVALID");
  });

  it("returns 400 when payload fields are invalid", async () => {
    const { database } = createFakeDb([]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: 123,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_INVALID");
  });

  it("returns 409 when an admin already exists", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ADMIN_BOOTSTRAP_ALREADY_COMPLETED");
  });

  it("creates admin human and PAT token once", async () => {
    const { database, humanInserts, apiKeyInserts, internalServiceInserts } =
      createFakeDb([]);

    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        status: string;
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
      internalService: {
        id: string;
        name: string;
      };
    };

    expect(body.human.id).toBe("00000000000000000000000000");
    expect(body.human.did).toBe(
      "did:cdi:127.0.0.1:human:00000000000000000000000000",
    );
    expect(body.human.displayName).toBe("Primary Admin");
    expect(body.human.role).toBe("admin");
    expect(body.human.status).toBe("active");
    expect(body.apiKey.name).toBe("prod-admin-key");
    expect(body.apiKey.token.startsWith("clw_pat_")).toBe(true);
    expect(body.internalService.id).toBe("proxy-pairing");
    expect(body.internalService.name).toBe("proxy-pairing");

    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(internalServiceInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.key_prefix).toBe(
      deriveApiKeyLookupPrefix(body.apiKey.token),
    );
    expect(apiKeyInserts[0]?.key_hash).toBe(
      await hashApiKeyToken(body.apiKey.token),
    );
    expect(internalServiceInserts[0]?.id).toBe("proxy-pairing");
    expect(internalServiceInserts[0]?.name).toBe("proxy-pairing");
    expect(internalServiceInserts[0]?.scopes_json).toBe(
      JSON.stringify(["identity.read"]),
    );
  });

  it("returns PAT that authenticates GET /v1/me on same app and database", async () => {
    const { database } = createFakeDb([]);
    const appInstance = createRegistryApp();

    const bootstrapResponse = await appInstance.request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(bootstrapResponse.status).toBe(201);
    const bootstrapBody = (await bootstrapResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
      internalService: {
        id: string;
        name: string;
      };
    };

    const meResponse = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${bootstrapBody.apiKey.token}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      },
    );

    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: string;
        onboardingSource: string | null;
        agentLimit: number | null;
        apiKey: {
          id: string;
          name: string;
        };
      };
    };
    expect(meBody.human).toEqual({
      id: bootstrapBody.human.id,
      did: bootstrapBody.human.did,
      displayName: bootstrapBody.human.displayName,
      role: bootstrapBody.human.role,
      onboardingSource: "admin_bootstrap",
      agentLimit: null,
      apiKey: {
        id: bootstrapBody.apiKey.id,
        name: bootstrapBody.apiKey.name,
      },
    });
  });

  it("falls back to manual mutation when transactions are unavailable", async () => {
    const { database, humanInserts, apiKeyInserts, internalServiceInserts } =
      createFakeDb([], [], {
        failBeginTransaction: true,
      });

    const response = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(response.status).toBe(201);
    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(internalServiceInserts).toHaveLength(1);
  });

  it("rolls back admin insert when fallback api key insert fails", async () => {
    const { database, humanRows } = createFakeDb([], [], {
      failBeginTransaction: true,
      failApiKeyInsertCount: 1,
    });

    const firstResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(firstResponse.status).toBe(500);
    expect(humanRows).toHaveLength(0);

    const secondResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(secondResponse.status).toBe(201);
    expect(humanRows).toHaveLength(1);
  });

  it("rolls back admin and api key when fallback internal service insert fails", async () => {
    const { database, humanRows, apiKeyRows } = createFakeDb([], [], {
      failBeginTransaction: true,
      failInternalServiceInsertCount: 1,
    });

    const firstResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(firstResponse.status).toBe(500);
    expect(humanRows).toHaveLength(0);
    expect(apiKeyRows).toHaveLength(0);

    const secondResponse = await createRegistryApp().request(
      ADMIN_BOOTSTRAP_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bootstrap-secret": "bootstrap-secret",
        },
        body: JSON.stringify({
          displayName: "Primary Admin",
          apiKeyName: "prod-admin-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET:
          TEST_BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        BOOTSTRAP_SECRET: "bootstrap-secret",
      },
    );

    expect(secondResponse.status).toBe(201);
    expect(humanRows).toHaveLength(1);
    expect(apiKeyRows).toHaveLength(1);
  });
});
