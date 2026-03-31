import {
  GROUP_JOIN_PATH,
  GROUP_MEMBERSHIP_CHECK_PATH,
  GROUPS_PATH,
  generateUlid,
  parseAgentDid,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { verifyAgentClawRequest } from "../../auth/agent-claw-auth.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import { constantTimeEqual } from "../../auth/api-key-token.js";
import { createServiceAuth } from "../../auth/service-auth.js";
import { createDb } from "../../db/client.js";
import {
  agents,
  group_join_tokens,
  group_members,
  groups,
} from "../../db/schema.js";
import {
  deriveGroupJoinTokenLookupPrefix,
  generateGroupJoinToken,
  hashGroupJoinToken,
  MAX_GROUP_MEMBERS,
  parseGroupCreatePayload,
  parseGroupIdPath,
  parseGroupJoinPayload,
  parseGroupJoinTokenIssuePayload,
} from "../../group-lifecycle.js";
import type { RegistryRouteDependencies } from "../constants.js";
import { DB_MUTATION_OPERATION } from "../helpers/db-mutation-operations.js";
import {
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
} from "../helpers/db-queries.js";
import {
  resolveManageableGroupForActor,
  resolveManageableGroupForHuman,
  resolveReadableGroupForActor,
} from "../helpers/group-access.js";
import { publishGroupMemberJoinedNotifications } from "../helpers/group-notifications.js";
import {
  assertAgentIsActiveCurrent,
  parseJsonBodyFromBytes,
  readRequestBodyBytes,
  resolveGroupRouteAuthActor,
} from "../helpers/group-route-auth.js";
import {
  groupCreateInvalidError,
  groupJoinTokenExhaustedError,
  groupJoinTokenExpiredError,
  groupJoinTokenInvalidError,
  groupJoinTokenIssueInvalidError,
  groupMemberLimitReachedError,
  groupMemberNotFoundError,
  groupNotFoundError,
} from "./group-route-errors.js";

export function registerGroupRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig, getEventBus } = input;

  app.post(GROUPS_PATH, async (c) => {
    const config = getConfig(c.env);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const db = createDb(c.env.DB);
    const actor = await resolveGroupRouteAuthActor({
      db,
      config,
      request: c.req.raw,
      bodyBytes,
    });

    const payload = parseJsonBodyFromBytes({
      bodyBytes,
      invalidError: groupCreateInvalidError,
    });
    const parsedPayload = parseGroupCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const nowMs = nowUtcMs();
    const createdAt = nowIso();
    const groupId = `grp_${generateUlid(nowMs)}`;

    await db.insert(groups).values({
      id: groupId,
      name: parsedPayload.name,
      created_by: actor.humanId,
      created_at: createdAt,
      updated_at: createdAt,
    });

    return c.json(
      {
        group: {
          id: groupId,
          name: parsedPayload.name,
          createdByHumanId: actor.humanId,
          createdAt,
        },
      },
      201,
    );
  });

  app.post(`${GROUPS_PATH}/:id/join-tokens`, async (c) => {
    const config = getConfig(c.env);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const groupId = parseGroupIdPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);
    const actor = await resolveGroupRouteAuthActor({
      db,
      config,
      request: c.req.raw,
      bodyBytes,
    });
    await resolveManageableGroupForActor({ db, groupId, actor });

    const payload = parseJsonBodyFromBytes({
      bodyBytes,
      invalidError: groupJoinTokenIssueInvalidError,
    });

    const nowMs = nowUtcMs();
    const parsedPayload = parseGroupJoinTokenIssuePayload({
      payload,
      environment: config.ENVIRONMENT,
      nowMs,
    });

    const token = generateGroupJoinToken();
    const tokenHash = await hashGroupJoinToken(token);
    const tokenPrefix = deriveGroupJoinTokenLookupPrefix(token);
    const tokenId = generateUlid(nowMs);
    const createdAt = nowIso();

    await db.insert(group_join_tokens).values({
      id: tokenId,
      group_id: groupId,
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      role: parsedPayload.role,
      max_uses: parsedPayload.maxUses,
      used_count: 0,
      expires_at: parsedPayload.expiresAt,
      revoked_at: null,
      issued_by: actor.humanId,
      created_at: createdAt,
      updated_at: createdAt,
    });

    return c.json(
      {
        groupJoinToken: {
          id: tokenId,
          token,
          groupId,
          role: parsedPayload.role,
          maxUses: parsedPayload.maxUses,
          expiresAt: parsedPayload.expiresAt,
          createdAt,
        },
      },
      201,
    );
  });

  app.post(GROUP_JOIN_PATH, async (c) => {
    const config = getConfig(c.env);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const payload = parseJsonBodyFromBytes({
      bodyBytes,
      invalidError: () =>
        new AppError({
          code: "GROUP_JOIN_INVALID",
          message: "Group join payload is invalid",
          status: 400,
          expose: true,
        }),
    });

    const parsedPayload = parseGroupJoinPayload({
      payload,
      environment: config.ENVIRONMENT,
    });
    const claims = await verifyAgentClawRequest({
      config,
      request: c.req.raw,
      bodyBytes,
    });

    const db = createDb(c.env.DB);
    const joiningAgent = await assertAgentIsActiveCurrent({
      db,
      agentDid: claims.sub,
      aitJti: claims.jti,
    });

    const tokenPrefix = deriveGroupJoinTokenLookupPrefix(
      parsedPayload.groupJoinToken,
    );
    const tokenHash = await hashGroupJoinToken(parsedPayload.groupJoinToken);

    const candidateTokens = await db
      .select({
        id: group_join_tokens.id,
        groupId: group_join_tokens.group_id,
        tokenHash: group_join_tokens.token_hash,
        role: group_join_tokens.role,
        maxUses: group_join_tokens.max_uses,
        usedCount: group_join_tokens.used_count,
        expiresAt: group_join_tokens.expires_at,
        revokedAt: group_join_tokens.revoked_at,
      })
      .from(group_join_tokens)
      .where(eq(group_join_tokens.token_prefix, tokenPrefix));

    const token = candidateTokens.find((row) =>
      constantTimeEqual(row.tokenHash, tokenHash),
    );
    if (!token || token.revokedAt !== null) {
      throw groupJoinTokenInvalidError();
    }

    const expiresAtMs = Date.parse(token.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowUtcMs()) {
      throw groupJoinTokenExpiredError();
    }

    if (token.usedCount >= token.maxUses) {
      throw groupJoinTokenExhaustedError();
    }

    const groupRows = await db
      .select({
        id: groups.id,
        name: groups.name,
        createdBy: groups.created_by,
      })
      .from(groups)
      .where(eq(groups.id, token.groupId))
      .limit(1);
    const group = groupRows[0];
    if (!group) {
      throw groupJoinTokenInvalidError();
    }

    const existingMemberRows = await db
      .select({
        role: group_members.role,
        joinedAt: group_members.joined_at,
      })
      .from(group_members)
      .where(
        and(
          eq(group_members.group_id, token.groupId),
          eq(group_members.agent_id, joiningAgent.id),
        ),
      )
      .limit(1);

    const existingMember = existingMemberRows[0];
    if (existingMember) {
      return c.json({
        joined: false,
        groupId: token.groupId,
        agentDid: claims.sub,
        role: existingMember.role,
        joinedAt: existingMember.joinedAt,
      });
    }

    const joinedAt = nowIso();
    const applyJoinMutation = async (
      executor: typeof db,
      options: { rollbackOnFailure: boolean },
    ): Promise<{
      joined: boolean;
      role: "member" | "admin";
      joinedAt: string;
    }> => {
      const memberInsertResult = await executor.run(sql`
        insert into group_members (group_id, agent_id, role, joined_at, updated_at)
        select ${token.groupId}, ${joiningAgent.id}, ${token.role}, ${joinedAt}, ${joinedAt}
        where (
          select count(*)
          from group_members
          where group_id = ${token.groupId}
        ) < ${MAX_GROUP_MEMBERS}
        and not exists (
          select 1
          from group_members
          where group_id = ${token.groupId}
            and agent_id = ${joiningAgent.id}
        )
      `);
      const insertedRows = getMutationRowCount({
        result: memberInsertResult,
        operation: DB_MUTATION_OPERATION.GROUP_MEMBER_JOIN_INSERT,
      });

      if (insertedRows === 0) {
        const concurrentExistingRows = await executor
          .select({
            role: group_members.role,
            joinedAt: group_members.joined_at,
          })
          .from(group_members)
          .where(
            and(
              eq(group_members.group_id, token.groupId),
              eq(group_members.agent_id, joiningAgent.id),
            ),
          )
          .limit(1);

        const concurrentExistingMember = concurrentExistingRows[0];
        if (concurrentExistingMember) {
          return {
            joined: false,
            role: concurrentExistingMember.role,
            joinedAt: concurrentExistingMember.joinedAt,
          };
        }

        throw groupMemberLimitReachedError();
      }

      try {
        const tokenUpdateResult = await executor
          .update(group_join_tokens)
          .set({
            used_count: sql`${group_join_tokens.used_count} + 1`,
            updated_at: joinedAt,
          })
          .where(
            and(
              eq(group_join_tokens.id, token.id),
              lt(group_join_tokens.used_count, group_join_tokens.max_uses),
              isNull(group_join_tokens.revoked_at),
            ),
          );

        const updatedRows = getMutationRowCount({
          result: tokenUpdateResult,
          operation: DB_MUTATION_OPERATION.GROUP_JOIN_TOKEN_USAGE_UPDATE,
        });
        if (updatedRows === 0) {
          throw groupJoinTokenExhaustedError();
        }
      } catch (error) {
        if (options.rollbackOnFailure) {
          await executor
            .delete(group_members)
            .where(
              and(
                eq(group_members.group_id, token.groupId),
                eq(group_members.agent_id, joiningAgent.id),
              ),
            );
        }
        throw error;
      }

      return {
        joined: true,
        role: token.role,
        joinedAt,
      };
    };

    let joinResult: {
      joined: boolean;
      role: "member" | "admin";
      joinedAt: string;
    };
    try {
      joinResult = await db.transaction(async (tx) => {
        return applyJoinMutation(tx as unknown as typeof db, {
          rollbackOnFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      joinResult = await applyJoinMutation(db, {
        rollbackOnFailure: true,
      });
    }

    if (!joinResult.joined) {
      return c.json({
        joined: false,
        groupId: token.groupId,
        agentDid: claims.sub,
        role: joinResult.role,
        joinedAt: joinResult.joinedAt,
      });
    }

    await publishGroupMemberJoinedNotifications({
      db,
      eventBus: getEventBus(c.env),
      creatorHumanId: group.createdBy,
      joinedAgentDid: claims.sub,
      joinedAgentName: joiningAgent.name,
      groupId: token.groupId,
      groupName: group.name,
      role: joinResult.role,
      joinedAt: joinResult.joinedAt,
      initiatedByAccountId: joiningAgent.ownerId,
    });

    return c.json(
      {
        joined: true,
        groupId: token.groupId,
        agentDid: claims.sub,
        role: joinResult.role,
        joinedAt: joinResult.joinedAt,
      },
      201,
    );
  });

  app.get(`${GROUPS_PATH}/:id/members`, async (c) => {
    const config = getConfig(c.env);
    const groupId = parseGroupIdPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const actor = await resolveGroupRouteAuthActor({
      db,
      config,
      request: c.req.raw,
      bodyBytes,
    });
    await resolveReadableGroupForActor({ db, groupId, actor });

    const memberRows = await db
      .select({
        agentDid: agents.did,
        role: group_members.role,
        joinedAt: group_members.joined_at,
      })
      .from(group_members)
      .innerJoin(agents, eq(group_members.agent_id, agents.id))
      .where(
        and(eq(group_members.group_id, groupId), eq(agents.status, "active")),
      );

    return c.json({
      group: {
        id: groupId,
      },
      members: memberRows,
    });
  });

  app.delete(
    `${GROUPS_PATH}/:id/members/:agentDid`,
    createApiKeyAuth(),
    async (c) => {
      const config = getConfig(c.env);
      const groupId = parseGroupIdPath({
        id: c.req.param("id"),
        environment: config.ENVIRONMENT,
      });
      const targetAgentDid = c.req.param("agentDid").trim();
      try {
        parseAgentDid(targetAgentDid);
      } catch {
        throw new AppError({
          code: "GROUP_MEMBER_INVALID_PATH",
          message: "Group member path is invalid",
          status: 400,
          expose: true,
        });
      }

      const human = c.get("human");
      const db = createDb(c.env.DB);

      await resolveManageableGroupForHuman({
        db,
        groupId,
        humanId: human.id,
      });

      const targetAgentRows = await db
        .select({
          id: agents.id,
        })
        .from(agents)
        .where(eq(agents.did, targetAgentDid))
        .limit(1);
      const targetAgent = targetAgentRows[0];
      if (!targetAgent) {
        throw groupMemberNotFoundError();
      }

      await db
        .delete(group_members)
        .where(
          and(
            eq(group_members.group_id, groupId),
            eq(group_members.agent_id, targetAgent.id),
          ),
        );

      return c.body(null, 204);
    },
  );

  app.delete(`${GROUPS_PATH}/:id`, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const groupId = parseGroupIdPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    await resolveManageableGroupForHuman({
      db,
      groupId,
      humanId: human.id,
    });

    const applyGroupDeleteMutation = async (executor: typeof db) => {
      await executor
        .delete(group_join_tokens)
        .where(eq(group_join_tokens.group_id, groupId));
      await executor
        .delete(group_members)
        .where(eq(group_members.group_id, groupId));
      await executor.delete(groups).where(eq(groups.id, groupId));
    };

    try {
      await db.transaction(async (tx) => {
        await applyGroupDeleteMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }
      await applyGroupDeleteMutation(db);
    }

    return c.body(null, 204);
  });

  app.post(
    GROUP_MEMBERSHIP_CHECK_PATH,
    createServiceAuth({ requiredScopes: ["groups.read"] }),
    async (c) => {
      let payload: unknown;
      try {
        payload = await c.req.json();
      } catch {
        throw new AppError({
          code: "GROUP_MEMBERSHIP_INVALID",
          message: "Group membership payload is invalid",
          status: 400,
          expose: true,
        });
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      ) {
        throw new AppError({
          code: "GROUP_MEMBERSHIP_INVALID",
          message: "Group membership payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const value = payload as Record<string, unknown>;
      if (
        typeof value.groupId !== "string" ||
        typeof value.memberAgentDid !== "string"
      ) {
        throw new AppError({
          code: "GROUP_MEMBERSHIP_INVALID",
          message: "Group membership payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const groupId = parseGroupIdPath({
        id: value.groupId,
        environment: getConfig(c.env).ENVIRONMENT,
      });
      const memberAgentDid = value.memberAgentDid.trim();
      try {
        parseAgentDid(memberAgentDid);
      } catch {
        throw new AppError({
          code: "GROUP_MEMBERSHIP_INVALID",
          message: "Group membership payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const db = createDb(c.env.DB);
      const membershipRows = await db
        .select({
          groupId: group_members.group_id,
        })
        .from(group_members)
        .innerJoin(agents, eq(group_members.agent_id, agents.id))
        .where(
          and(
            eq(group_members.group_id, groupId),
            eq(agents.did, memberAgentDid),
            eq(agents.status, "active"),
          ),
        )
        .limit(1);

      return c.json({
        isMember: Boolean(membershipRows[0]),
      });
    },
  );

  app.get(`${GROUPS_PATH}/:id`, async (c) => {
    const config = getConfig(c.env);
    const groupId = parseGroupIdPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const actor = await resolveGroupRouteAuthActor({
      db,
      config,
      request: c.req.raw,
      bodyBytes,
    });
    const resolvedGroup = await resolveReadableGroupForActor({
      db,
      groupId,
      actor,
    });

    return c.json({
      group: {
        id: resolvedGroup.id,
        name: resolvedGroup.name,
      },
    });
  });
}
