import { describe, expect, it } from "vitest";
import { resolveManageableGroupForAgent } from "./group-access.js";

function createSequentialLimitDb(resultSets: Array<unknown[]>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const nextResult = resultSets.shift();
            if (!nextResult) {
              throw new Error("unexpected query in test double");
            }
            return nextResult;
          },
        }),
      }),
    }),
  };
}

describe("resolveManageableGroupForAgent", () => {
  it("rejects non-creators for group management", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const agentId = "agent-admin";
    const db = createSequentialLimitDb([
      [
        {
          id: groupId,
          name: "alpha squad",
          createdBy: "human-owner",
        },
      ],
    ]);

    await expect(
      resolveManageableGroupForAgent({
        db: db as never,
        groupId,
        humanId: "human-admin",
        agentId,
      }),
    ).rejects.toMatchObject({ code: "GROUP_MANAGE_FORBIDDEN" });
  });
});
