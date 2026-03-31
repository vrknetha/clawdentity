import { GROUP_MEMBER_JOINED_EVENT_TYPE } from "@clawdentity/protocol";
import { createInMemoryEventBus } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { publishGroupMemberJoinedNotifications } from "./group-notifications.js";

describe("publishGroupMemberJoinedNotifications", () => {
  it("publishes one event per active creator-owned agent", async () => {
    const creatorHumanId = "human-creator";
    const joiningAgentDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97";
    const database = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
            },
            {
              did: "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHC1",
            },
            {
              did: joiningAgentDid,
            },
          ],
        }),
      }),
    };
    const eventBus = createInMemoryEventBus();

    await publishGroupMemberJoinedNotifications({
      db: database as never,
      eventBus,
      creatorHumanId,
      joinedAgentDid: joiningAgentDid,
      joinedAgentName: "beta",
      groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
      groupName: "alpha squad",
      role: "member",
      joinedAt: "2026-03-31T00:00:00.000Z",
      initiatedByAccountId: "human-joiner",
    });

    expect(eventBus.publishedEvents).toHaveLength(2);
    expect(eventBus.publishedEvents[0]).toMatchObject({
      type: GROUP_MEMBER_JOINED_EVENT_TYPE,
      initiatedByAccountId: "human-joiner",
      data: {
        joinedAgentDid: joiningAgentDid,
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        groupName: "alpha squad",
        message: "beta joined alpha squad.",
      },
    });
    expect(
      eventBus.publishedEvents.map(
        (event) =>
          (event.data as { recipientAgentDid: string }).recipientAgentDid,
      ),
    ).toEqual([
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHC1",
    ]);
  });

  it("returns early when event bus is unavailable", async () => {
    const database = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    };
    await expect(
      publishGroupMemberJoinedNotifications({
        db: database as never,
        eventBus: undefined,
        creatorHumanId: "human-creator",
        joinedAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        joinedAgentName: "beta",
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        groupName: "alpha squad",
        role: "member",
        joinedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});
