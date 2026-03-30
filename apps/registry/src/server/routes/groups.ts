import {
  GROUP_JOIN_PATH,
  GROUP_MEMBERSHIP_CHECK_PATH,
  GROUPS_PATH,
  generateUlid,
  parseAgentDid,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { and, eq, sql } from "drizzle-orm";
import { verifyAgentClawRequest } from "../../auth/agent-claw-auth.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import {
  constantTimeEqual,
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
  parseBearerPat,
} from "../../auth/api-key-token.js";
import { createServiceAuth } from "../../auth/service-auth.js";
import { createDb } from "../../db/client.js";
import {
  agents,
  api_keys,
  group_join_tokens,
  group_members,
  groups,
  humans,
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

function groupNotFoundError(): AppError {
  return new AppError({
    code: "GROUP_NOT_FOUND",
    message: "Group was not found",
    status: 404,
    expose: true,
  });
}

function groupManageForbiddenError(): AppError {
  return new AppError({
    code: "GROUP_MANAGE_FORBIDDEN",
    message: "Group management access is forbidden",
    status: 403,
    expose: true,
  });
}

function groupJoinTokenInvalidError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_INVALID",
    message: "Group join token is invalid",
    status: 400,
    expose: true,
  });
}

function groupJoinTokenExpiredError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_EXPIRED",
    message: "Group join token has expired",
    status: 400,
    expose: true,
  });
}

function groupJoinTokenExhaustedError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_TOKEN_EXHAUSTED",
    message: "Group join token has already been used",
    status: 409,
    expose: true,
  });
}

function groupMemberLimitReachedError(): AppError {
  return new AppError({
    code: "GROUP_MEMBER_LIMIT_REACHED",
    message: `Group cannot have more than ${MAX_GROUP_MEMBERS} members`,
    status: 409,
    expose: true,
  });
}

function groupJoinForbiddenError(): AppError {
  return new AppError({
    code: "GROUP_JOIN_FORBIDDEN",
    message: "Agent is not allowed to join this group",
    status: 403,
    expose: true,
  });
}

async function resolvePatHuman(input: {
  db: ReturnType<typeof createDb>;
  authorizationHeader: string | undefined;
}) {
  const token = parseBearerPat(input.authorizationHeader);
  const tokenHash = await hashApiKeyToken(token);
  const tokenPrefix = deriveApiKeyLookupPrefix(token);

  const lookupResult = await input.db
    .select({
      apiKeyId: api_keys.id,
      keyHash: api_keys.key_hash,
      apiKeyStatus: api_keys.status,
      apiKeyName: api_keys.name,
      humanId: humans.id,
      humanDid: humans.did,
      humanDisplayName: humans.display_name,
      humanRole: humans.role,
      humanStatus: humans.status,
    })
    .from(api_keys)
    .innerJoin(humans, eq(humans.id, api_keys.human_id))
    .where(eq(api_keys.key_prefix, tokenPrefix));

  const matched =
    lookupResult.find((row) => constantTimeEqual(row.keyHash, tokenHash)) ??
    undefined;

  if (
    !matched ||
    matched.apiKeyStatus !== "active" ||
    matched.humanStatus !== "active"
  ) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "API key is invalid",
      status: 401,
      expose: true,
    });
  }

  return {
    id: matched.humanId,
    did: matched.humanDid,
    displayName: matched.humanDisplayName,
    role: matched.humanRole,
    apiKey: {
      id: matched.apiKeyId,
      name: matched.apiKeyName,
    },
  };
}

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
    const payload = await c.req.json();
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
      payload = {};
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

    const [{ memberCount }] = await db
      .select({
        memberCount: sql<number>`count(*)`,
      })
      .from(group_members)
      .where(eq(group_members.group_id, token.groupId));

    if (memberCount >= MAX_GROUP_MEMBERS) {
      throw groupMemberLimitReachedError();
    }

    const joinedAt = nowIso();
    const applyJoinMutation = async (
      executor: typeof db,
      options: { rollbackOnFailure: boolean },
    ): Promise<void> => {
      await executor.insert(group_members).values({
        group_id: token.groupId,
        agent_id: joiningAgent.id,
        role: token.role,
        joined_at: joinedAt,
        updated_at: joinedAt,
      });

      try {
        const tokenUpdateResult = await executor
          .update(group_join_tokens)
          .set({
            used_count: token.usedCount + 1,
            updated_at: joinedAt,
          })
          .where(
            and(
              eq(group_join_tokens.id, token.id),
              eq(group_join_tokens.used_count, token.usedCount),
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
    };

    try {
      await db.transaction(async (tx) => {
        await applyJoinMutation(tx as unknown as typeof db, {
          rollbackOnFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyJoinMutation(db, {
        rollbackOnFailure: true,
      });
    }

    return c.json(
      {
        joined: true,
        groupId: token.groupId,
        agentDid: claims.sub,
        role: token.role,
        joinedAt,
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
        throw groupNotFoundError();
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

    await db
      .delete(group_join_tokens)
      .where(eq(group_join_tokens.group_id, groupId));
    await db.delete(group_members).where(eq(group_members.group_id, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));

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
