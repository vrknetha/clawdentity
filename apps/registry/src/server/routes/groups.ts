// biome-ignore lint/nursery/noExcessiveLinesPerFile: Group route handlers and shared helpers are co-located for now; split into dedicated modules in a follow-up.
import {
  decodeBase64url,
  encodeBase64url,
  GROUP_JOIN_PATH,
  GROUP_MEMBERSHIP_CHECK_PATH,
  GROUPS_PATH,
  generateUlid,
  parseAgentDid,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { logger } from "../constants.js";
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
  groupJoinTokenInvalidError,
  groupJoinTokenIssueInvalidError,
  groupJoinTokenSchemaOutdatedError,
  groupMemberLimitReachedError,
  groupMemberNotFoundError,
} from "./group-route-errors.js";

const GROUP_JOIN_TOKEN_MARKER = "clw_gjt_";
const GROUP_JOIN_TOKEN_CIPHER_AAD = "clawdentity.group-join-token.v1";

function normalizeStoredGroupJoinToken(token: string): string | null {
  const trimmed = token.trim();
  if (
    !trimmed.startsWith(GROUP_JOIN_TOKEN_MARKER) ||
    trimmed.length <= GROUP_JOIN_TOKEN_MARKER.length
  ) {
    return null;
  }
  return trimmed;
}

async function deriveGroupJoinTokenCipherKey(
  bootstrapInternalServiceSecret: string,
): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `group-join-token:${bootstrapInternalServiceSecret.trim()}`,
    ),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptGroupJoinTokenForStorage(input: {
  token: string;
  bootstrapInternalServiceSecret: string;
}): Promise<string> {
  const key = await deriveGroupJoinTokenCipherKey(
    input.bootstrapInternalServiceSecret,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(GROUP_JOIN_TOKEN_CIPHER_AAD),
    },
    key,
    new TextEncoder().encode(input.token),
  );
  return `${encodeBase64url(iv)}.${encodeBase64url(new Uint8Array(encrypted))}`;
}

async function decryptGroupJoinTokenFromStorage(input: {
  ciphertext: string;
  bootstrapInternalServiceSecret: string;
}): Promise<string | null> {
  const [ivPart, cipherPart, ...rest] = input.ciphertext.split(".");
  if (
    typeof ivPart !== "string" ||
    typeof cipherPart !== "string" ||
    rest.length > 0
  ) {
    return null;
  }

  try {
    const key = await deriveGroupJoinTokenCipherKey(
      input.bootstrapInternalServiceSecret,
    );
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decodeBase64url(ivPart),
        additionalData: new TextEncoder().encode(GROUP_JOIN_TOKEN_CIPHER_AAD),
      },
      key,
      decodeBase64url(cipherPart),
    );
    const token = new TextDecoder().decode(decrypted);
    return normalizeStoredGroupJoinToken(token);
  } catch {
    return null;
  }
}

function isGroupJoinTokenSchemaError(error: unknown): boolean {
  const messages: string[] = [];
  const collect = (value: unknown): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      messages.push(value);
      return;
    }
    if (typeof value === "object") {
      if ("message" in value && typeof value.message === "string") {
        messages.push(value.message);
      }
      if ("cause" in value) {
        collect(value.cause);
      }
    }
  };
  collect(error);

  return messages.some((message) => {
    const lowered = message.toLowerCase();
    return (
      lowered.includes("token_ciphertext") &&
      (lowered.includes("no such column") ||
        lowered.includes("has no column named"))
    );
  });
}

async function withGroupJoinTokenSchemaGuard<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isGroupJoinTokenSchemaError(error)) {
      throw groupJoinTokenSchemaOutdatedError();
    }
    throw error;
  }
}

export function registerGroupRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig, getEventBus } = input;

  app.post(GROUPS_PATH, async (c) => {
    const config = getConfig(c.env);
    const bodyBytes = await readRequestBodyBytes(c.req.raw);
    const db = createDb(c.env.DB);
    const claims = await verifyAgentClawRequest({
      config,
      request: c.req.raw,
      bodyBytes,
    });
    const creatorAgent = await assertAgentIsActiveCurrent({
      db,
      agentDid: claims.sub,
      aitJti: claims.jti,
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
    const applyCreateMutation = async (executor: typeof db) => {
      await executor.insert(groups).values({
        id: groupId,
        name: parsedPayload.name,
        created_by: creatorAgent.ownerId,
        created_at: createdAt,
        updated_at: createdAt,
      });
      await executor.insert(group_members).values({
        group_id: groupId,
        agent_id: creatorAgent.id,
        role: "admin",
        joined_at: createdAt,
        updated_at: createdAt,
      });
    };

    try {
      await db.transaction(async (tx) => {
        await applyCreateMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }
      await applyCreateMutation(db);
    }

    return c.json(
      {
        group: {
          id: groupId,
          name: parsedPayload.name,
          createdByHumanId: creatorAgent.ownerId,
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

    parseGroupJoinTokenIssuePayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const nowMs = nowUtcMs();
    const issuedAt = nowIso();
    const activeTokenRows = await withGroupJoinTokenSchemaGuard(() =>
      db
        .select({
          id: group_join_tokens.id,
          groupId: group_join_tokens.group_id,
          tokenHash: group_join_tokens.token_hash,
          tokenPrefix: group_join_tokens.token_prefix,
          tokenCiphertext: group_join_tokens.token_ciphertext,
          role: group_join_tokens.role,
          revokedAt: group_join_tokens.revoked_at,
          createdAt: group_join_tokens.created_at,
        })
        .from(group_join_tokens)
        .where(
          and(
            eq(group_join_tokens.group_id, groupId),
            isNull(group_join_tokens.revoked_at),
          ),
        ),
    );
    if (activeTokenRows.length > 0) {
      const activeTokensByNewest = [...activeTokenRows].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      let selectedActiveToken:
        | {
            id: string;
            groupId: string;
            role: "member" | "admin";
            createdAt: string;
            token: string;
          }
        | undefined;

      for (const activeToken of activeTokensByNewest) {
        const decrypted = await decryptGroupJoinTokenFromStorage({
          ciphertext: activeToken.tokenCiphertext,
          bootstrapInternalServiceSecret:
            config.BOOTSTRAP_INTERNAL_SERVICE_SECRET,
        });
        if (!decrypted) {
          continue;
        }
        const [decryptedHash, decryptedPrefix] = await Promise.all([
          hashGroupJoinToken(decrypted),
          Promise.resolve(deriveGroupJoinTokenLookupPrefix(decrypted)),
        ]);
        if (
          constantTimeEqual(decryptedHash, activeToken.tokenHash) &&
          constantTimeEqual(decryptedPrefix, activeToken.tokenPrefix)
        ) {
          selectedActiveToken = {
            id: activeToken.id,
            groupId: activeToken.groupId,
            role: activeToken.role,
            createdAt: activeToken.createdAt,
            token: decrypted,
          };
          break;
        }
      }

      if (selectedActiveToken) {
        if (activeTokenRows.length > 1) {
          await db
            .update(group_join_tokens)
            .set({
              revoked_at: issuedAt,
              updated_at: issuedAt,
            })
            .where(
              and(
                eq(group_join_tokens.group_id, groupId),
                isNull(group_join_tokens.revoked_at),
                sql`${group_join_tokens.id} <> ${selectedActiveToken.id}`,
              ),
            );
        }

        return c.json({
          groupJoinToken: {
            id: selectedActiveToken.id,
            token: selectedActiveToken.token,
            groupId: selectedActiveToken.groupId,
            role: selectedActiveToken.role,
            createdAt: selectedActiveToken.createdAt,
            active: true,
          },
        });
      }

      await db
        .update(group_join_tokens)
        .set({
          revoked_at: issuedAt,
          updated_at: issuedAt,
        })
        .where(
          and(
            eq(group_join_tokens.group_id, groupId),
            isNull(group_join_tokens.revoked_at),
          ),
        );
    }

    const token = generateGroupJoinToken();
    const [tokenHash, tokenCiphertext] = await Promise.all([
      hashGroupJoinToken(token),
      encryptGroupJoinTokenForStorage({
        token,
        bootstrapInternalServiceSecret:
          config.BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      }),
    ]);
    const tokenPrefix = deriveGroupJoinTokenLookupPrefix(token);
    const tokenId = generateUlid(nowMs);
    const createdAt = issuedAt;

    await withGroupJoinTokenSchemaGuard(() =>
      db.insert(group_join_tokens).values({
        id: tokenId,
        group_id: groupId,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        token_ciphertext: tokenCiphertext,
        role: "member",
        revoked_at: null,
        issued_by: actor.humanId,
        created_at: createdAt,
        updated_at: createdAt,
      }),
    );

    return c.json(
      {
        groupJoinToken: {
          id: tokenId,
          token,
          groupId,
          role: "member",
          createdAt,
          active: true,
        },
      },
      201,
    );
  });

  app.post(`${GROUPS_PATH}/:id/join-tokens/reset`, async (c) => {
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
    await resolveManageableGroupForActor({ db, groupId, actor });

    const nowMs = nowUtcMs();
    const now = nowIso();
    const token = generateGroupJoinToken();
    const [tokenHash, tokenCiphertext] = await Promise.all([
      hashGroupJoinToken(token),
      encryptGroupJoinTokenForStorage({
        token,
        bootstrapInternalServiceSecret:
          config.BOOTSTRAP_INTERNAL_SERVICE_SECRET,
      }),
    ]);
    const tokenPrefix = deriveGroupJoinTokenLookupPrefix(token);
    const tokenId = generateUlid(nowMs);

    const insertReplacementToken = async (executor: typeof db) => {
      await withGroupJoinTokenSchemaGuard(() =>
        executor.insert(group_join_tokens).values({
          id: tokenId,
          group_id: groupId,
          token_hash: tokenHash,
          token_prefix: tokenPrefix,
          token_ciphertext: tokenCiphertext,
          role: "member",
          revoked_at: null,
          issued_by: actor.humanId,
          created_at: now,
          updated_at: now,
        }),
      );
    };

    const revokePreviousActiveTokens = async (executor: typeof db) => {
      await executor
        .update(group_join_tokens)
        .set({
          revoked_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(group_join_tokens.group_id, groupId),
            isNull(group_join_tokens.revoked_at),
            sql`${group_join_tokens.id} <> ${tokenId}`,
          ),
        );
    };

    const applyResetMutation = async (executor: typeof db) => {
      await insertReplacementToken(executor);
      await revokePreviousActiveTokens(executor);
    };

    try {
      await db.transaction(async (tx) => {
        await applyResetMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await insertReplacementToken(db);
      try {
        await revokePreviousActiveTokens(db);
      } catch (fallbackError) {
        const compensationRevokedAt = nowIso();
        try {
          await db
            .update(group_join_tokens)
            .set({
              revoked_at: compensationRevokedAt,
              updated_at: compensationRevokedAt,
            })
            .where(
              and(
                eq(group_join_tokens.id, tokenId),
                isNull(group_join_tokens.revoked_at),
              ),
            );
        } catch (compensationError) {
          logger.error("registry.group_join_token_reset_compensation_failed", {
            groupId,
            tokenId,
            error:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          });
        }
        throw fallbackError;
      }
    }

    return c.json(
      {
        groupJoinToken: {
          id: tokenId,
          token,
          groupId,
          role: "member",
          createdAt: now,
          active: true,
        },
      },
      201,
    );
  });

  app.delete(`${GROUPS_PATH}/:id/join-tokens/current`, async (c) => {
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
    await resolveManageableGroupForActor({ db, groupId, actor });

    const now = nowIso();
    await db
      .update(group_join_tokens)
      .set({
        revoked_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(group_join_tokens.group_id, groupId),
          isNull(group_join_tokens.revoked_at),
        ),
      );

    return c.body(null, 204);
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

    const groupRows = await db
      .select({
        id: groups.id,
        name: groups.name,
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
        return applyJoinMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      joinResult = await applyJoinMutation(db);
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

    const joinedHumanRows = await db
      .select({
        humanDid: humans.did,
        displayName: humans.display_name,
      })
      .from(humans)
      .where(eq(humans.id, joiningAgent.ownerId))
      .limit(1);
    const joinedHuman = joinedHumanRows[0];

    if (joinedHuman) {
      await publishGroupMemberJoinedNotifications({
        db,
        eventBus: getEventBus(c.env),
        joinedAgentDid: claims.sub,
        joinedAgentName: joiningAgent.name,
        joinedAgentDisplayName: joinedHuman.displayName,
        joinedAgentFramework: joiningAgent.framework ?? "unknown",
        joinedAgentHumanDid: joinedHuman.humanDid,
        joinedAgentStatus: joiningAgent.status,
        groupId: token.groupId,
        groupName: group.name,
        role: joinResult.role,
        joinedAt: joinResult.joinedAt,
        initiatedByAccountId: joiningAgent.ownerId,
      });
    } else {
      logger.warn("registry.group.member_joined_notification_missing_human", {
        groupId: token.groupId,
        joinedAgentDid: claims.sub,
        ownerId: joiningAgent.ownerId,
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
        agentName: agents.name,
        displayName: humans.display_name,
        framework: agents.framework,
        humanDid: humans.did,
        status: agents.status,
        role: group_members.role,
        joinedAt: group_members.joined_at,
      })
      .from(group_members)
      .innerJoin(agents, eq(group_members.agent_id, agents.id))
      .innerJoin(humans, eq(agents.owner_id, humans.id))
      .where(
        and(eq(group_members.group_id, groupId), eq(agents.status, "active")),
      );

    const members = memberRows.map((member) => ({
      ...member,
      framework: member.framework ?? "unknown",
    }));

    return c.json({
      group: {
        id: groupId,
      },
      members,
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
