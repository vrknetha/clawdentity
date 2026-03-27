import { describe, expect, it, vi } from "vitest";
import {
  AGENT_AUTH_REVOKED_EVENT_TYPE,
  handleRegistryRevocationEvent,
  parseRegistryRevocationEvent,
} from "./registry-events.js";

describe("registry revocation queue events", () => {
  it("parses hard-revoke events with metadata agent DID", () => {
    const event = parseRegistryRevocationEvent({
      type: AGENT_AUTH_REVOKED_EVENT_TYPE,
      id: "evt-1",
      version: "v1",
      timestampUtc: "2026-03-27T00:00:00.000Z",
      initiatedByAccountId:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT00W6W7CM7N3W5FDXT4",
      data: {
        reason: "agent_revoked",
        metadata: {
          agentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe(AGENT_AUTH_REVOKED_EVENT_TYPE);
  });

  it("ignores revoked events that are not hard agent revokes", () => {
    const event = parseRegistryRevocationEvent({
      type: AGENT_AUTH_REVOKED_EVENT_TYPE,
      id: "evt-2",
      version: "v1",
      timestampUtc: "2026-03-27T00:00:00.000Z",
      initiatedByAccountId:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT00W6W7CM7N3W5FDXT4",
      data: {
        reason: "owner_auth_revoke",
        metadata: {
          agentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      },
    });

    expect(event).toBeNull();
  });

  it("rejects malformed hard-revoke events", () => {
    expect(() =>
      parseRegistryRevocationEvent({
        type: AGENT_AUTH_REVOKED_EVENT_TYPE,
        id: "evt-3",
        version: "v1",
        timestampUtc: "2026-03-27T00:00:00.000Z",
        initiatedByAccountId:
          "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT00W6W7CM7N3W5FDXT4",
        data: {
          reason: "agent_revoked",
          metadata: {},
        },
      }),
    ).toThrow("metadata must include a non-empty agentDid");
  });

  it("routes hard revoke marker to trust-state durable object", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json({ ok: true }, { status: 200 }),
    );
    const trustStateNamespace = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: fetchSpy,
      })),
    };

    const event = parseRegistryRevocationEvent({
      type: AGENT_AUTH_REVOKED_EVENT_TYPE,
      id: "evt-4",
      version: "v1",
      timestampUtc: "2026-03-27T00:00:00.000Z",
      initiatedByAccountId:
        "did:cdi:dev.registry.clawdentity.com:human:01HF7YAT00W6W7CM7N3W5FDXT4",
      data: {
        reason: "agent_revoked",
        metadata: {
          agentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      },
    });
    if (event === null) {
      throw new Error("Expected revocation event to parse");
    }

    await handleRegistryRevocationEvent({
      event,
      trustStateNamespace,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/agents/revoked/mark");
    expect((await request.json()) as { agentDid?: string }).toEqual({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
    });
  });
});
