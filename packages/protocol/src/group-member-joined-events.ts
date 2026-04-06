import { parseAgentDid, parseGroupId, parseHumanDid } from "./did.js";

export const GROUP_MEMBER_JOINED_EVENT_TYPE = "group.member.joined";
export const GROUP_MEMBER_JOINED_TRUSTED_DELIVERY_SOURCE =
  "proxy.events.queue.group_member_joined";
export const GROUP_MEMBER_JOINED_NOTIFICATION_MESSAGE =
  "A member joined your group.";

export type GroupMemberJoinedRole = "member" | "admin";
export type GroupMemberJoinedAgentStatus = "active" | "revoked";

export type GroupMemberJoinedAgent = {
  displayName: string;
  framework: string;
  humanDid: string;
  status: GroupMemberJoinedAgentStatus;
};

export type GroupMemberJoinedEventData = {
  recipientAgentDid: string;
  joinedAgentDid: string;
  joinedAgentName: string;
  joinedAgent: GroupMemberJoinedAgent;
  groupId: string;
  groupName: string;
  role: GroupMemberJoinedRole;
  joinedAt: string;
  message?: string;
};

function parseNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Group member joined event field '${field}' must be a non-empty string`,
    );
  }
  return value.trim();
}

function parseAgentDidString(value: unknown, field: string): string {
  const normalized = parseNonBlankString(value, field);
  parseAgentDid(normalized);
  return normalized;
}

function parseGroupIdString(value: unknown, field: string): string {
  const normalized = parseNonBlankString(value, field);
  return parseGroupId(normalized);
}

function parseHumanDidString(value: unknown, field: string): string {
  const normalized = parseNonBlankString(value, field);
  parseHumanDid(normalized);
  return normalized;
}

function parseRole(value: unknown): GroupMemberJoinedRole {
  if (value === "member" || value === "admin") {
    return value;
  }
  throw new Error(
    "Group member joined event field 'role' must be either 'member' or 'admin'",
  );
}

function parseAgentStatus(value: unknown): GroupMemberJoinedAgentStatus {
  if (value === "active" || value === "revoked") {
    return value;
  }
  throw new Error(
    "Group member joined event field 'joinedAgent.status' must be either 'active' or 'revoked'",
  );
}

function parseJoinedAt(value: unknown): string {
  const normalized = parseNonBlankString(value, "joinedAt");
  const isoTimestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoTimestampPattern.test(normalized)) {
    throw new Error(
      "Group member joined event field 'joinedAt' must be a valid ISO timestamp",
    );
  }

  const epochMs = Date.parse(normalized);
  if (Number.isNaN(epochMs)) {
    throw new Error(
      "Group member joined event field 'joinedAt' must be a valid ISO timestamp",
    );
  }

  return new Date(epochMs).toISOString();
}

function parseOptionalMessage(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      "Group member joined event field 'message' must be a string",
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

export function createGroupMemberJoinedNotificationMessage(input: {
  joinedAgentName: string;
  groupName: string;
}): string {
  const joinedAgentName = parseNonBlankString(
    input.joinedAgentName,
    "joinedAgentName",
  );
  const groupName = parseNonBlankString(input.groupName, "groupName");
  return `${joinedAgentName} joined ${groupName}.`;
}

export function parseGroupMemberJoinedEventData(
  payload: unknown,
): GroupMemberJoinedEventData {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Group member joined event payload must be an object");
  }

  const candidate = payload as {
    recipientAgentDid?: unknown;
    joinedAgentDid?: unknown;
    joinedAgentName?: unknown;
    joinedAgent?: unknown;
    groupId?: unknown;
    groupName?: unknown;
    role?: unknown;
    joinedAt?: unknown;
    message?: unknown;
  };

  const message = parseOptionalMessage(candidate.message);

  const joinedAgentCandidate = candidate.joinedAgent;
  if (
    typeof joinedAgentCandidate !== "object" ||
    joinedAgentCandidate === null ||
    Array.isArray(joinedAgentCandidate)
  ) {
    throw new Error(
      "Group member joined event field 'joinedAgent' must be an object",
    );
  }
  const joinedAgentObject = joinedAgentCandidate as {
    displayName?: unknown;
    framework?: unknown;
    humanDid?: unknown;
    status?: unknown;
  };

  return {
    recipientAgentDid: parseAgentDidString(
      candidate.recipientAgentDid,
      "recipientAgentDid",
    ),
    joinedAgentDid: parseAgentDidString(
      candidate.joinedAgentDid,
      "joinedAgentDid",
    ),
    joinedAgentName: parseNonBlankString(
      candidate.joinedAgentName,
      "joinedAgentName",
    ),
    joinedAgent: {
      displayName: parseNonBlankString(
        joinedAgentObject.displayName,
        "joinedAgent.displayName",
      ),
      framework: parseNonBlankString(
        joinedAgentObject.framework,
        "joinedAgent.framework",
      ),
      humanDid: parseHumanDidString(
        joinedAgentObject.humanDid,
        "joinedAgent.humanDid",
      ),
      status: parseAgentStatus(joinedAgentObject.status),
    },
    groupId: parseGroupIdString(candidate.groupId, "groupId"),
    groupName: parseNonBlankString(candidate.groupName, "groupName"),
    role: parseRole(candidate.role),
    joinedAt: parseJoinedAt(candidate.joinedAt),
    ...(message === undefined ? {} : { message }),
  };
}
