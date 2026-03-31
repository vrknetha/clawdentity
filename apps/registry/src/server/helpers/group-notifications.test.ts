import { GROUP_MEMBER_JOINED_EVENT_TYPE } from "@clawdentity/protocol";
import { createInMemoryEventBus } from "@clawdentity/sdk";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../constants.js";
import { publishGroupMemberJoinedNotifications } from "./group-notifications.js";

describe("publishGroupMemberJoinedNotifications", () => {
  it("publishes one event per active creator-owned agent", async () => {
    const creatorHumanId = "human-creator";
    const joiningAgentDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97";
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
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
          where: () => ({
            limit: async () => [],
          }),
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

  it("logs and returns when creator agent resolution fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error("db unavailable");
            },
          }),
        }),
      }),
    };
    const eventBus = createInMemoryEventBus();

    await expect(
      publishGroupMemberJoinedNotifications({
        db: database as never,
        eventBus,
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

    expect(warnSpy).toHaveBeenCalledWith(
      "registry.group.member_joined_event_resolution_failed",
      expect.objectContaining({
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        joinedAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      }),
    );
    warnSpy.mockRestore();
  });

  it("logs recipient publish failures and continues with remaining agents", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const recipientOneDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
    const recipientTwoDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHC1";
    const joinedAgentDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97";
    const deliveredRecipients: string[] = [];
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { did: recipientOneDid },
              { did: recipientTwoDid },
            ],
          }),
        }),
      }),
    };
    const eventBus = {
      publish: vi.fn(async (event) => {
        const recipientAgentDid = (event.data as { recipientAgentDid: string })
          .recipientAgentDid;
        if (recipientAgentDid === recipientOneDid) {
          throw new Error("queue publish failed");
        }
        deliveredRecipients.push(recipientAgentDid);
      }),
    };

    await expect(
      publishGroupMemberJoinedNotifications({
        db: database as never,
        eventBus: eventBus as never,
        creatorHumanId: "human-creator",
        joinedAgentDid,
        joinedAgentName: "beta",
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        groupName: "alpha squad",
        role: "member",
        joinedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).resolves.toBeUndefined();

    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(deliveredRecipients).toEqual([recipientTwoDid]);
    expect(warnSpy).toHaveBeenCalledWith(
      "registry.group.member_joined_event_publish_failed",
      expect.objectContaining({
        recipientAgentDid: recipientOneDid,
      }),
    );
    warnSpy.mockRestore();
  });
});
