import {
  createGroupMemberJoinedNotificationMessage,
  GROUP_MEMBER_JOINED_EVENT_TYPE,
} from "@clawdentity/protocol";
import { createEventEnvelope, type EventBus } from "@clawdentity/sdk";
import { and, eq } from "drizzle-orm";
import type { createDb } from "../../db/client.js";
import { agents, group_members } from "../../db/schema.js";
import { logger, REGISTRY_SERVICE_EVENT_VERSION } from "../constants.js";

export async function publishGroupMemberJoinedNotifications(input: {
  db: ReturnType<typeof createDb>;
  eventBus?: EventBus;
  joinedAgentDid: string;
  joinedAgentName: string;
  joinedAgentDisplayName: string;
  joinedAgentFramework: string;
  joinedAgentHumanDid: string;
  joinedAgentStatus: "active" | "revoked";
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
    const groupMemberRows = await input.db
      .select({
        did: agents.did,
      })
      .from(group_members)
      .innerJoin(agents, eq(group_members.agent_id, agents.id))
      .where(
        and(
          eq(group_members.group_id, input.groupId),
          eq(agents.status, "active"),
        ),
      )
      .limit(100);

    const notificationMessage = createGroupMemberJoinedNotificationMessage({
      joinedAgentName: input.joinedAgentName,
      groupName: input.groupName,
    });

    for (const groupMember of groupMemberRows) {
      try {
        await input.eventBus.publish(
          createEventEnvelope({
            type: GROUP_MEMBER_JOINED_EVENT_TYPE,
            version: REGISTRY_SERVICE_EVENT_VERSION,
            timestampUtc: input.joinedAt,
            initiatedByAccountId: input.initiatedByAccountId ?? null,
            data: {
              recipientAgentDid: groupMember.did,
              joinedAgentDid: input.joinedAgentDid,
              joinedAgentName: input.joinedAgentName,
              joinedAgent: {
                displayName: input.joinedAgentDisplayName,
                framework: input.joinedAgentFramework,
                humanDid: input.joinedAgentHumanDid,
                status: input.joinedAgentStatus,
              },
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
          recipientAgentDid: groupMember.did,
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
