import { describe, expect, it, vi } from "vitest";
import { PROXY_VERSION } from "./index.js";
import { type ProxyWorkerBindings, worker } from "./worker.js";

function createTrustStateNamespace(): NonNullable<
  ProxyWorkerBindings["PROXY_TRUST_STATE"]
> {
  return {
    idFromName: vi.fn(
      (name: string) =>
        ({ toString: () => name }) as unknown as DurableObjectId,
    ),
    get: vi.fn(() => ({
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    })),
  };
}

function createNonceReplayNamespace(): NonNullable<
  ProxyWorkerBindings["NONCE_REPLAY_GUARD"]
> {
  return {
    idFromName: vi.fn(
      (name: string) =>
        ({ toString: () => name }) as unknown as DurableObjectId,
    ),
    get: vi.fn(() => ({
      fetch: vi.fn(async () =>
        Response.json({
          accepted: true,
          seenAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      ),
    })),
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function createRelaySessionNamespace(): NonNullable<
  ProxyWorkerBindings["AGENT_RELAY_SESSION"]
> {
  return {} as NonNullable<ProxyWorkerBindings["AGENT_RELAY_SESSION"]>;
}

function createRequiredBindings(
  overrides: ProxyWorkerBindings = {},
): ProxyWorkerBindings {
  return {
    ENVIRONMENT: "local",
    REGISTRY_URL: "https://registry.example.test",
    AGENT_RELAY_SESSION: createRelaySessionNamespace(),
    NONCE_REPLAY_GUARD: createNonceReplayNamespace(),
    BOOTSTRAP_INTERNAL_SERVICE_ID: "svc-proxy-registry",
    BOOTSTRAP_INTERNAL_SERVICE_SECRET: "secret-proxy-registry",
    ...overrides,
  };
}

describe("proxy worker", () => {
  it("serves /health with parsed runtime config from bindings", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        APP_VERSION: "sha-worker-123",
        ENVIRONMENT: "local",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      ready: boolean;
      version: string;
      environment: string;
      readiness: {
        versionSource: string;
      };
    };
    expect(payload).toMatchObject({
      status: "ok",
      version: "sha-worker-123",
      environment: "local",
      ready: true,
      readiness: {
        versionSource: "APP_VERSION",
      },
    });
  });

  it("allows local startup without nonce replay DO binding", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "local",
        NONCE_REPLAY_GUARD: undefined,
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      ready: boolean;
      version: string;
      environment: string;
    };
    expect(payload.status).toBe("ok");
    expect(payload.version).toBe(PROXY_VERSION);
    expect(payload.environment).toBe("local");
    expect(payload.ready).toBe(true);
  });

  it("allows development startup when trust DO binding exists", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "development",
        PROXY_TRUST_STATE: createTrustStateNamespace(),
        NONCE_REPLAY_GUARD: createNonceReplayNamespace(),
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      environment: string;
    };
    expect(payload.status).toBe("ok");
    expect(payload.environment).toBe("development");
  });

  it("fails startup in development when trust DO binding is missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "development",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(payload.error.details.fieldErrors?.PROXY_TRUST_STATE?.[0]).toContain(
      "ENVIRONMENT is 'development'",
    );
  });

  it("fails startup in production when trust DO binding is missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "production",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(payload.error.details.fieldErrors?.PROXY_TRUST_STATE?.[0]).toContain(
      "ENVIRONMENT is 'production'",
    );
  });

  it("fails startup in development when nonce replay DO binding is missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "development",
        PROXY_TRUST_STATE: createTrustStateNamespace(),
        NONCE_REPLAY_GUARD: undefined,
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(
      payload.error.details.fieldErrors?.NONCE_REPLAY_GUARD?.[0],
    ).toContain("ENVIRONMENT is 'development'");
  });

  it("fails startup in production when nonce replay DO binding is missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        ENVIRONMENT: "production",
        PROXY_TRUST_STATE: createTrustStateNamespace(),
        NONCE_REPLAY_GUARD: undefined,
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(
      payload.error.details.fieldErrors?.NONCE_REPLAY_GUARD?.[0],
    ).toContain("ENVIRONMENT is 'production'");
  });

  it("returns config validation error for malformed OPENCLAW_BASE_URL", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
        OPENCLAW_BASE_URL: "bad-url",
      }),
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
  });

  it("fails startup when required runtime bindings are missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        ENVIRONMENT: "local",
      } satisfies ProxyWorkerBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(payload.error.details.fieldErrors?.REGISTRY_URL).toBeUndefined();
    expect(
      payload.error.details.fieldErrors?.BOOTSTRAP_INTERNAL_SERVICE_ID?.[0],
    ).toBe("BOOTSTRAP_INTERNAL_SERVICE_ID is required");
    expect(
      payload.error.details.fieldErrors?.BOOTSTRAP_INTERNAL_SERVICE_SECRET?.[0],
    ).toBe("BOOTSTRAP_INTERNAL_SERVICE_SECRET is required");
  });
});
