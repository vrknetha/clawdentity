import { describe, expect, it } from "vitest";
import {
  createPairAcceptedEvent,
  PAIR_ACCEPTED_EVENT_TYPE,
  parsePairAcceptedEvent,
} from "./pairing-events.js";

describe("pair accepted event contract", () => {
  it("parses and normalizes valid event payload", () => {
    const parsed = parsePairAcceptedEvent({
      type: PAIR_ACCEPTED_EVENT_TYPE,
      initiatorAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7 ",
      responderAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97 ",
      responderProfile: {
        agentName: " beta ",
        humanName: " Ira ",
        proxyOrigin: "https://beta.proxy.example/path?ignored=1",
      },
      issuerProxyOrigin: "https://proxy.clawdentity.dev/pair/confirm",
      eventTimestampUtc: "2026-03-28T00:00:00.000Z",
    });

    expect(parsed).toEqual({
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

  it("fails on invalid payload shape", () => {
    expect(() =>
      parsePairAcceptedEvent({
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
        eventTimestampUtc: "not-an-iso-date",
      }),
    ).toThrow(
      "Pair accepted event field 'responderProfile.proxyOrigin' must be a non-empty string",
    );
  });

  it("creates normalized events from typed input", () => {
    const event = createPairAcceptedEvent({
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

    expect(event.type).toBe(PAIR_ACCEPTED_EVENT_TYPE);
  });
});
