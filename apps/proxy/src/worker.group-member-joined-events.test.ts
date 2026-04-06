import { GROUP_MEMBER_JOINED_EVENT_TYPE } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentRelaySessionStub } from "./agent-relay-session.js";
import { type ProxyWorkerBindings, worker } from "./worker.js";

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

describe("proxy worker group.member.joined queue routing", () => {
  it("routes group.member.joined events to recipient relay session", async () => {
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
            id: "evt-group-member-joined-1",
            type: GROUP_MEMBER_JOINED_EVENT_TYPE,
            version: "v1",
            timestampUtc: "2026-03-31T00:00:00.000Z",
            initiatedByAccountId: "human-joiner",
            data: {
              recipientAgentDid:
                "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
              joinedAgentDid:
                "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
              joinedAgentName: "beta",
              joinedAgent: {
                displayName: "Beta User",
                framework: "openclaw",
                humanDid:
                  "did:cdi:registry.clawdentity.dev:human:01HF7YAT8M89D8W9DH2S5Y4JQK",
                status: "active",
              },
              groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
              groupName: "alpha squad",
              role: "member",
              joinedAt: "2026-03-31T00:00:00.000Z",
              message: "beta joined alpha squad.",
            },
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
      groupId?: string;
      payload?: {
        type?: string;
        event?: string;
        message?: string;
      };
    };
    expect(body).toMatchObject({
      senderAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      recipientAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      deliverySource: "proxy.events.queue.group_member_joined",
      groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
      payload: {
        type: "clawdentity:group-member-joined",
        event: GROUP_MEMBER_JOINED_EVENT_TYPE,
        message: "beta joined alpha squad.",
      },
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it("acks malformed group.member.joined events without retrying", async () => {
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
            id: "evt-group-member-joined-1",
            type: GROUP_MEMBER_JOINED_EVENT_TYPE,
            version: "v1",
            timestampUtc: "2026-03-31T00:00:00.000Z",
            initiatedByAccountId: "human-joiner",
            data: {
              recipientAgentDid:
                "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
              joinedAgentDid:
                "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
              joinedAgentName: "",
              joinedAgent: {
                displayName: "Beta User",
                framework: "openclaw",
                humanDid:
                  "did:cdi:registry.clawdentity.dev:human:01HF7YAT8M89D8W9DH2S5Y4JQK",
                status: "active",
              },
              groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
              groupName: "alpha squad",
              role: "member",
              joinedAt: "2026-03-31T00:00:00.000Z",
            },
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
});
