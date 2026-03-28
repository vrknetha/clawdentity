import { describe, expect, it, vi } from "vitest";
import type { AgentRelaySessionStub } from "./agent-relay-session.js";
import { type ProxyWorkerBindings, worker } from "./worker.js";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
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
    AGENT_RELAY_SESSION: {} as NonNullable<
      ProxyWorkerBindings["AGENT_RELAY_SESSION"]
    >,
    BOOTSTRAP_INTERNAL_SERVICE_ID: "svc-proxy-registry",
    BOOTSTRAP_INTERNAL_SERVICE_SECRET: "secret-proxy-registry",
    ...overrides,
  };
}

describe("proxy worker pair.accepted queue routing", () => {
  it("routes pair.accepted queue events to initiator relay session", async () => {
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
            type: "pair.accepted",
            initiatorAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            responderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            responderProfile: {
              agentName: "beta",
              humanName: "Ira",
              proxyOrigin: "https://beta.proxy.example",
            },
            issuerProxyOrigin: "https://proxy.clawdentity.dev",
            eventTimestampUtc: "2026-03-28T00:00:00.000Z",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/rpc/deliver-to-connector");
    const body = (await request.json()) as {
      senderAgentDid?: string;
      recipientAgentDid?: string;
      deliverySource?: string;
      payload?: {
        system?: {
          type?: string;
        };
      };
    };
    expect(body).toMatchObject({
      senderAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      recipientAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      deliverySource: "proxy.events.queue.pair_accepted",
      payload: {
        system: {
          type: "pair.accepted",
        },
      },
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("acks malformed pair.accepted queue events without retrying", async () => {
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
            type: "pair.accepted",
            initiatorAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            responderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            responderProfile: {
              agentName: "beta",
            },
            issuerProxyOrigin: "https://proxy.clawdentity.dev",
            eventTimestampUtc: "2026-03-28T00:00:00.000Z",
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

  it("acks pair.accepted queue events when AGENT_RELAY_SESSION is unavailable", async () => {
    const bindings = createRequiredBindings({
      AGENT_RELAY_SESSION: undefined,
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const queueBatch = {
      messages: [
        {
          body: JSON.stringify({
            type: "pair.accepted",
            initiatorAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            responderAgentDid:
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            responderProfile: {
              agentName: "beta",
              humanName: "Ira",
              proxyOrigin: "https://beta.proxy.example",
            },
            issuerProxyOrigin: "https://proxy.clawdentity.dev",
            eventTimestampUtc: "2026-03-28T00:00:00.000Z",
          }),
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<string>;

    await worker.queue(queueBatch, bindings);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
