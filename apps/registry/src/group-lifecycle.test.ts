import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_MEMBERS,
  parseGroupCreatePayload,
  parseGroupJoinPayload,
  parseGroupJoinTokenIssuePayload,
} from "./group-lifecycle.js";

describe("group-lifecycle", () => {
  it("parses create payload", () => {
    expect(
      parseGroupCreatePayload({
        payload: { name: "Ops Team" },
        environment: "local",
      }),
    ).toEqual({ name: "Ops Team" });
  });

  it("rejects invalid create payload", () => {
    try {
      parseGroupCreatePayload({
        payload: { name: "" },
        environment: "local",
      });
      throw new Error("Expected parseGroupCreatePayload to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "GROUP_CREATE_INVALID" });
    }
  });

  it("parses join token issue payload defaults", () => {
    const nowMs = 1_700_000_000_000;
    const parsed = parseGroupJoinTokenIssuePayload({
      payload: {},
      environment: "local",
      nowMs,
    });

    expect(parsed.maxUses).toBe(1);
    expect(parsed.role).toBe("member");
    expect(typeof parsed.expiresAt).toBe("string");
  });

  it("enforces token maxUses cap aligned to group member limit", () => {
    try {
      parseGroupJoinTokenIssuePayload({
        payload: { maxUses: MAX_GROUP_MEMBERS + 1 },
        environment: "local",
        nowMs: Date.now(),
      });
      throw new Error("Expected parseGroupJoinTokenIssuePayload to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "GROUP_JOIN_TOKEN_ISSUE_INVALID" });
    }
  });

  it("parses join payload with group join token naming", () => {
    expect(
      parseGroupJoinPayload({
        payload: { groupJoinToken: "clw_gjt_abc123" },
        environment: "local",
      }),
    ).toEqual({
      groupJoinToken: "clw_gjt_abc123",
    });
  });
});
