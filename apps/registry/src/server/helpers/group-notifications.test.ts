import { GROUP_MEMBER_JOINED_EVENT_TYPE } from "@clawdentity/protocol";
import { createInMemoryEventBus } from "@clawdentity/sdk";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../constants.js";
import { publishGroupMemberJoinedNotifications } from "./group-notifications.js";

function createGroupMemberDbRows(dids: string[]) {
  return {
    select: () => ({
      from: (_table: unknown) => ({
        innerJoin: (_joined: unknown, _on: unknown) => ({
          where: () => ({
            limit: async () => dids.map((did) => ({ did })),
          }),
        }),
      }),
    }),
  };
}

function joinedAgentPayload() {
  return {
    joinedAgentDid:
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
    joinedAgentName: "beta",
    joinedAgentDisplayName: "Beta User",
    joinedAgentFramework: "openclaw",
    joinedAgentHumanDid:
      "did:cdi:registry.clawdentity.dev:human:01HF7YAT8M89D8W9DH2S5Y4JQK",
    joinedAgentStatus: "active" as const,
    groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
    groupName: "alpha squad",
    role: "member" as const,
    joinedAt: "2026-03-31T00:00:00.000Z",
  };
}

describe("publishGroupMemberJoinedNotifications", () => {
  it("publishes one event per active group member, including the joined member", async () => {
    const joiningAgentDid = joinedAgentPayload().joinedAgentDid;
    const database = createGroupMemberDbRows([
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHC1",
      joiningAgentDid,
    ]);
    const eventBus = createInMemoryEventBus();

    await publishGroupMemberJoinedNotifications({
      db: database as never,
      eventBus,
      ...joinedAgentPayload(),
      initiatedByAccountId: "human-joiner",
    });

    expect(eventBus.publishedEvents).toHaveLength(3);
    expect(eventBus.publishedEvents[0]).toMatchObject({
      type: GROUP_MEMBER_JOINED_EVENT_TYPE,
      initiatedByAccountId: "human-joiner",
      data: {
        joinedAgentDid: joiningAgentDid,
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
      joiningAgentDid,
    ]);
  });

  it("returns early when event bus is unavailable", async () => {
    const database = createGroupMemberDbRows([]);
    await expect(
      publishGroupMemberJoinedNotifications({
        db: database as never,
        eventBus: undefined,
        ...joinedAgentPayload(),
      }),
    ).resolves.toBeUndefined();
  });

  it("logs and returns when group-member resolution fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const database = {
      select: () => ({
        from: (_table: unknown) => ({
          innerJoin: (_joined: unknown, _on: unknown) => ({
            where: () => ({
              limit: async () => {
                throw new Error("db unavailable");
              },
            }),
          }),
        }),
      }),
    };
    const eventBus = createInMemoryEventBus();

    await expect(
      publishGroupMemberJoinedNotifications({
        db: database as never,
        eventBus,
        ...joinedAgentPayload(),
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

  it("logs recipient publish failures and continues with remaining members", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const recipientOneDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
    const recipientTwoDid =
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHC1";
    const deliveredRecipients: string[] = [];
    const database = createGroupMemberDbRows([
      recipientOneDid,
      recipientTwoDid,
    ]);
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
        ...joinedAgentPayload(),
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
