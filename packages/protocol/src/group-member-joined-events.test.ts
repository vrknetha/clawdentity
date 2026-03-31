import { describe, expect, it } from "vitest";
import {
  createGroupMemberJoinedNotificationMessage,
  GROUP_MEMBER_JOINED_NOTIFICATION_MESSAGE,
  parseGroupMemberJoinedEventData,
} from "./group-member-joined-events.js";

describe("group member joined event contract", () => {
  it("parses and normalizes valid payload", () => {
    const parsed = parseGroupMemberJoinedEventData({
      recipientAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7 ",
      joinedAgentDid:
        " did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97 ",
      joinedAgentName: " beta ",
      groupId: " grp_01HF7YAT31JZHSMW1CG6Q6MHB7 ",
      groupName: " alpha squad ",
      role: "member",
      joinedAt: "2026-03-31T12:00:00.000+05:30",
      message: " beta joined alpha squad. ",
    });

    expect(parsed).toEqual({
      recipientAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      joinedAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      joinedAgentName: "beta",
      groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
      groupName: "alpha squad",
      role: "member",
      joinedAt: "2026-03-31T06:30:00.000Z",
      message: "beta joined alpha squad.",
    });
  });

  it("rejects invalid payload fields", () => {
    expect(() =>
      parseGroupMemberJoinedEventData({
        recipientAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        joinedAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        joinedAgentName: "",
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        groupName: "alpha squad",
        role: "member",
        joinedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toThrow(
      "Group member joined event field 'joinedAgentName' must be a non-empty string",
    );
  });

  it("creates deterministic notification copy", () => {
    expect(
      createGroupMemberJoinedNotificationMessage({
        joinedAgentName: "beta",
        groupName: "alpha squad",
      }),
    ).toBe("beta joined alpha squad.");
    expect(GROUP_MEMBER_JOINED_NOTIFICATION_MESSAGE).toBe(
      "A member joined your group.",
    );
  });
});
