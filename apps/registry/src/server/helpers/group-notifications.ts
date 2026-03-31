import {
  createGroupMemberJoinedNotificationMessage,
  GROUP_MEMBER_JOINED_EVENT_TYPE,
} from "@clawdentity/protocol";
import { createEventEnvelope, type EventBus } from "@clawdentity/sdk";
import { and, eq } from "drizzle-orm";
import type { createDb } from "../../db/client.js";
import { agents } from "../../db/schema.js";
import { logger, REGISTRY_SERVICE_EVENT_VERSION } from "../constants.js";

export async function publishGroupMemberJoinedNotifications(input: {
  db: ReturnType<typeof createDb>;
  eventBus?: EventBus;
  creatorHumanId: string;
  joinedAgentDid: string;
  joinedAgentName: string;
  groupId: string;
  groupName: string;
  role: "member" | "admin";
  joinedAt: string;
  initiatedByAccountId?: string | null;
}): Promise<void> {
  if (input.eventBus === undefined) {
    return;
  }

  try {
    const creatorAgentRows = await input.db
      .select({
        did: agents.did,
      })
      .from(agents)
      .where(
        and(
          eq(agents.owner_id, input.creatorHumanId),
          eq(agents.status, "active"),
        ),
      );

    const notificationMessage = createGroupMemberJoinedNotificationMessage({
      joinedAgentName: input.joinedAgentName,
      groupName: input.groupName,
    });

    for (const creatorAgent of creatorAgentRows) {
      if (creatorAgent.did === input.joinedAgentDid) {
        continue;
      }

      try {
        await input.eventBus.publish(
          createEventEnvelope({
            type: GROUP_MEMBER_JOINED_EVENT_TYPE,
            version: REGISTRY_SERVICE_EVENT_VERSION,
            timestampUtc: input.joinedAt,
            initiatedByAccountId: input.initiatedByAccountId ?? null,
            data: {
              recipientAgentDid: creatorAgent.did,
              joinedAgentDid: input.joinedAgentDid,
              joinedAgentName: input.joinedAgentName,
              groupId: input.groupId,
              groupName: input.groupName,
              role: input.role,
              joinedAt: input.joinedAt,
              message: notificationMessage,
            },
          }),
        );
      } catch (error) {
        logger.warn("registry.group.member_joined_event_publish_failed", {
          groupId: input.groupId,
          joinedAgentDid: input.joinedAgentDid,
          recipientAgentDid: creatorAgent.did,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  } catch (error) {
    logger.warn("registry.group.member_joined_event_resolution_failed", {
      groupId: input.groupId,
      joinedAgentDid: input.joinedAgentDid,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
