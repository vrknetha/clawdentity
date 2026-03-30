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
import { createApiKeyAuth, resolvePatHuman } from "../../auth/api-key-auth.js";
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
  groupCreateInvalidError,
  groupJoinForbiddenError,
  groupJoinTokenExhaustedError,
  groupJoinTokenExpiredError,
  groupJoinTokenInvalidError,
  groupJoinTokenIssueInvalidError,
  groupManageForbiddenError,
  groupMemberLimitReachedError,
  groupMemberNotFoundError,
  groupNotFoundError,
} from "./group-route-errors.js";

async function assertHumanCanManageGroup(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  humanId: string;
}) {
  const groupRows = await input.db
    .select({
      id: groups.id,
      createdBy: groups.created_by,
    })
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .limit(1);

  const group = groupRows[0];
  if (!group) {
    throw groupNotFoundError();
  }

  if (group.createdBy === input.humanId) {
    return;
  }

  const adminMembershipRows = await input.db
    .select({
      agentId: agents.id,
    })
    .from(group_members)
    .innerJoin(agents, eq(group_members.agent_id, agents.id))
    .where(
      and(
        eq(group_members.group_id, input.groupId),
        eq(group_members.role, "admin"),
        eq(agents.owner_id, input.humanId),
        eq(agents.status, "active"),
      ),
    )
    .limit(1);

  if (!adminMembershipRows[0]) {
    throw groupManageForbiddenError();
  }
}

async function assertAgentIsActiveCurrent(input: {
  db: ReturnType<typeof createDb>;
  agentDid: string;
  aitJti: string;
}) {
  const rows = await input.db
    .select({
      id: agents.id,
      status: agents.status,
      currentJti: agents.current_jti,
    })
    .from(agents)
    .where(eq(agents.did, input.agentDid))
    .limit(1);

  const row = rows[0];
  if (!row || row.status !== "active" || row.currentJti !== input.aitJti) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
      message: "Agent access token is invalid",
      status: 401,
      expose: true,
    });
  }

  return row;
}

export function registerGroupRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig } = input;

  app.post(GROUPS_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw groupCreateInvalidError();
    }
    const parsedPayload = parseGroupCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const human = c.get("human");
    const nowMs = nowUtcMs();
    const createdAt = nowIso();
    const groupId = `grp_${generateUlid(nowMs)}`;
    const db = createDb(c.env.DB);

    await db.insert(groups).values({
      id: groupId,
      name: parsedPayload.name,
      created_by: human.id,
      created_at: createdAt,
      updated_at: createdAt,
    });

    return c.json(
      {
        group: {
          id: groupId,
          name: parsedPayload.name,
          createdByHumanId: human.id,
          createdAt,
        },
      },
      201,
    );
  });

  app.post(`${GROUPS_PATH}/:id/join-tokens`, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw groupJoinTokenIssueInvalidError();
    }

    const groupId = parseGroupIdPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    await assertHumanCanManageGroup({
      db,
      groupId,
      humanId: human.id,
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
      issued_by: human.id,
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
    const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());

    let payload: unknown;
    try {
      const rawBody = new TextDecoder().decode(bodyBytes);
      payload = rawBody.trim().length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      throw new AppError({
        code: "GROUP_JOIN_INVALID",
        message: "Group join payload is invalid",
        status: 400,
        expose: true,
      });
    }

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
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, token.groupId))
      .limit(1);
    if (!groupRows[0]) {
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
    const authorization = c.req.header("authorization");

    const isBearer =
      typeof authorization === "string" && authorization.startsWith("Bearer ");
    if (isBearer) {
      const human = await resolvePatHuman({
        db,
        authorizationHeader: authorization,
        touchLastUsed: true,
      });
      await assertHumanCanManageGroup({
        db,
        groupId,
        humanId: human.id,
      });
    } else {
      const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      const claims = await verifyAgentClawRequest({
        config,
        request: c.req.raw,
        bodyBytes,
      });

      const activeAgent = await assertAgentIsActiveCurrent({
        db,
        agentDid: claims.sub,
        aitJti: claims.jti,
      });

      const membershipRows = await db
        .select({
          agentId: group_members.agent_id,
        })
        .from(group_members)
        .where(
          and(
            eq(group_members.group_id, groupId),
            eq(group_members.agent_id, activeAgent.id),
          ),
        )
        .limit(1);

      if (!membershipRows[0]) {
        throw groupJoinForbiddenError();
      }
    }

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

      await assertHumanCanManageGroup({
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

    await assertHumanCanManageGroup({
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
}
