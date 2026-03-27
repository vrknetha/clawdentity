import { describe, expect, it, vi } from "vitest";
import {
  handlePairAcceptedQueueEvent,
  PAIR_ACCEPTED_EVENT_TYPE,
  parsePairAcceptedQueueEvent,
} from "./pairing-events.js";

describe("pair accepted queue events", () => {
  it("parses valid payloads and normalizes fields", () => {
    const event = parsePairAcceptedQueueEvent({
      type: PAIR_ACCEPTED_EVENT_TYPE,
      initiatorAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7 ",
      responderAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97 ",
      responderProfile: {
        agentName: " beta ",
        humanName: " Ira ",
        proxyOrigin: "https://beta.proxy.example/hook",
      },
      issuerProxyOrigin: "https://proxy.clawdentity.dev/pair/confirm",
      eventTimestampUtc: "2026-03-28T00:00:00.000Z",
    });

    expect(event).toEqual({
      type: PAIR_ACCEPTED_EVENT_TYPE,
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
    });
  });

  it("fails deterministically on invalid payloads", () => {
    expect(() =>
      parsePairAcceptedQueueEvent({
        type: PAIR_ACCEPTED_EVENT_TYPE,
        initiatorAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        responderAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderProfile: {
          agentName: "beta",
        },
        issuerProxyOrigin: "https://proxy.clawdentity.dev",
        eventTimestampUtc: "not-an-iso-date",
      }),
    ).toThrow(
      "Pair accepted event field 'responderProfile.humanName' must be a non-empty string",
    );
  });

  it("routes events to initiator relay session using relay delivery RPC", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const relaySessionNamespace = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: fetchSpy,
      })),
    };

    await handlePairAcceptedQueueEvent({
      event: parsePairAcceptedQueueEvent({
        type: PAIR_ACCEPTED_EVENT_TYPE,
        initiatorAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        responderAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderProfile: {
          agentName: "beta",
          humanName: "Ira",
        },
        issuerProxyOrigin: "https://proxy.clawdentity.dev",
        eventTimestampUtc: "2026-03-28T00:00:00.000Z",
      }),
      relaySessionNamespace,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/rpc/deliver-to-connector");
    const payload = (await request.json()) as {
      senderAgentDid?: string;
      recipientAgentDid?: string;
      payload?: {
        system?: {
          type?: string;
        };
      };
    };
    expect(payload.senderAgentDid).toBe(
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
    );
    expect(payload.recipientAgentDid).toBe(
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
    );
    expect(payload.payload?.system?.type).toBe(PAIR_ACCEPTED_EVENT_TYPE);
  });
});
