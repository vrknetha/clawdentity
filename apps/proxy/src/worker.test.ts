import { describe, expect, it, vi } from "vitest";
import type { AgentRelaySessionStub } from "./agent-relay-session.js";
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

function createRelaySessionNamespaceWithFetchSpy(
  fetchSpy: ReturnType<typeof vi.fn>,
): NonNullable<ProxyWorkerBindings["AGENT_RELAY_SESSION"]> {
  const invokeFetchSpy = fetchSpy as unknown as (
    request: Request,
  ) => Promise<Response>;
  const relayStub: AgentRelaySessionStub = {
    fetch: async (request: Request) => invokeFetchSpy(request),
  };

  return {
    idFromName: vi.fn(
      (name: string) =>
        ({ toString: () => name }) as unknown as DurableObjectId,
    ),
    get: vi.fn(() => relayStub),
  };
}

function createRequiredBindings(
  overrides: ProxyWorkerBindings = {},
): ProxyWorkerBindings {
  return {
    ENVIRONMENT: "local",
    REGISTRY_URL: "https://registry.example.test",
    AGENT_RELAY_SESSION: createRelaySessionNamespace(),
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

  it("allows local startup without trust DO binding", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      createRequiredBindings({
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

  it("routes delivery_receipt queue events to sender relay session", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: createRelaySessionNamespaceWithFetchSpy(fetchSpy),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "delivery_receipt",
            requestId: "req-queue-2",
            senderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            recipientAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            status: "dead_lettered",
            reason: "hook failed",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/rpc/record-delivery-receipt");
    const body = (await request.json()) as {
      requestId?: string;
      senderAgentDid?: string;
      recipientAgentDid?: string;
      status?: string;
      reason?: string;
    };
    expect(body).toMatchObject({
      requestId: "req-queue-2",
      status: "dead_lettered",
      reason: "hook failed",
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("acks unsupported queue event types without retrying", async () => {
    const fetchSpy = vi.fn();
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: createRelaySessionNamespaceWithFetchSpy(fetchSpy),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "agent.auth.created",
            agentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("acks malformed delivery_receipt queue events without retrying", async () => {
    const fetchSpy = vi.fn();
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: createRelaySessionNamespaceWithFetchSpy(fetchSpy),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "delivery_receipt",
            senderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            recipientAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            status: "dead_lettered",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries delivery_receipt queue events on transient relay failures", async () => {
    const fetchSpy = vi.fn(async (_request: Request) => {
      throw new TypeError("network unavailable");
    });
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: createRelaySessionNamespaceWithFetchSpy(fetchSpy),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "delivery_receipt",
            requestId: "req-queue-transient",
            senderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            recipientAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            status: "dead_lettered",
            reason: "hook failed",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("acks delivery_receipt queue events on non-transient relay failures", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json(
        {
          error: {
            code: "PROXY_RELAY_RECEIPT_WRITE_FAILED",
            message: "Relay delivery receipt write RPC failed",
          },
        },
        { status: 400 },
      ),
    );
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: createRelaySessionNamespaceWithFetchSpy(fetchSpy),
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "delivery_receipt",
            requestId: "req-queue-permanent",
            senderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            recipientAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            status: "dead_lettered",
            reason: "hook failed",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
