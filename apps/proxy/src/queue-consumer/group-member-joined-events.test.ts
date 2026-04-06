import {
  createGroupMemberJoinedNotificationMessage,
  GROUP_MEMBER_JOINED_EVENT_TYPE,
} from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  handleGroupMemberJoinedQueueEvent,
  parseGroupMemberJoinedQueueEvent,
} from "./group-member-joined-events.js";

describe("group member joined queue events", () => {
  it("parses valid event envelopes and normalizes data fields", () => {
    const event = parseGroupMemberJoinedQueueEvent({
      id: "evt-group-member-joined-1",
      type: GROUP_MEMBER_JOINED_EVENT_TYPE,
      version: "v1",
      timestampUtc: "2026-03-31T00:00:00.000Z",
      initiatedByAccountId: "human-joiner",
      data: {
        recipientAgentDid:
          " did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7 ",
        joinedAgentDid:
          " did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97 ",
        joinedAgentName: " beta ",
        joinedAgent: {
          displayName: " Beta User ",
          framework: " openclaw ",
          humanDid:
            " did:cdi:registry.clawdentity.dev:human:01HF7YAT8M89D8W9DH2S5Y4JQK ",
          status: "active",
        },
        groupId: " grp_01HF7YAT31JZHSMW1CG6Q6MHB7 ",
        groupName: " alpha squad ",
        role: "member",
        joinedAt: "2026-03-31T05:30:00+05:30",
      },
    });

    expect(event.data).toEqual({
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
    });
  });

  it("fails deterministically on malformed event data", () => {
    expect(() =>
      parseGroupMemberJoinedQueueEvent({
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
    ).toThrow(
      "Group member joined event field 'joinedAgentName' must be a non-empty string",
    );
  });

  it("routes events to recipient relay session with trusted delivery source", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const relaySessionNamespace = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: fetchSpy,
      })),
    };
    const recipientAgentDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
    const joinedAgentDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97";

    await handleGroupMemberJoinedQueueEvent({
      event: parseGroupMemberJoinedQueueEvent({
        id: "evt-group-member-joined-1",
        type: GROUP_MEMBER_JOINED_EVENT_TYPE,
        version: "v1",
        timestampUtc: "2026-03-31T00:00:00.000Z",
        initiatedByAccountId: "human-joiner",
        data: {
          recipientAgentDid,
          joinedAgentDid,
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
        },
      }),
      relaySessionNamespace,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/rpc/deliver-to-connector");
    const payload = (await request.json()) as {
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
    expect(payload.senderAgentDid).toBe(joinedAgentDid);
    expect(payload.recipientAgentDid).toBe(recipientAgentDid);
    expect(payload.deliverySource).toBe(
      "proxy.events.queue.group_member_joined",
    );
    expect(payload.groupId).toBe("grp_01HF7YAT31JZHSMW1CG6Q6MHB7");
    expect(payload.payload?.type).toBe("clawdentity:group-member-joined");
    expect(payload.payload?.event).toBe(GROUP_MEMBER_JOINED_EVENT_TYPE);
    expect(payload.payload?.message).toBe(
      createGroupMemberJoinedNotificationMessage({
        joinedAgentName: "beta",
        groupName: "alpha squad",
      }),
    );
  });
});
