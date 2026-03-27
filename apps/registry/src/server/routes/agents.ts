import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  generateUlid,
} from "@clawdentity/protocol";
import {
  AppError,
  nowIso,
  nowUtcMs,
  shouldExposeVerboseErrors,
  signAIT,
} from "@clawdentity/sdk";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  issueAgentAuth,
  toAgentAuthResponse,
} from "../../agent-auth-lifecycle.js";
import { mapAgentListRow, parseAgentListQuery } from "../../agent-list.js";
import { parseAgentOwnershipPath } from "../../agent-ownership.js";
import {
  buildAgentRegistrationChallenge,
  buildAgentRegistrationFromParsed,
  buildAgentReissue,
  parseAgentRegistrationBody,
  resolveRegistryIssuer,
  verifyAgentRegistrationOwnershipProof,
} from "../../agent-registration.js";
import {
  agentNotFoundError,
  invalidAgentReissueStateError,
  invalidAgentRevokeStateError,
  parseAgentRevokePath,
} from "../../agent-revocation.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import { createDb } from "../../db/client.js";
import {
  agent_auth_sessions,
  agent_registration_challenges,
  agents,
  revocations,
} from "../../db/schema.js";
import { resolveRegistrySigner } from "../../registry-signer.js";
import { logger, type RegistryRouteDependencies } from "../constants.js";
import {
  countAgentsByOwner,
  findAgentAuthSessionByAgentId,
  findOwnedAgent,
  findOwnedAgentRegistrationChallenge,
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
} from "../helpers/db-queries.js";
import { insertAgentAuthEvent } from "../helpers/event-bus.js";
import {
  requireCurrentJti,
  resolvePublicRegistryIssuer,
} from "../helpers/parsers.js";

export function registerAgentRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig, getEventBus } = input;

  app.get("/v1/agents", createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const query = parseAgentListQuery({
      query: c.req.query(),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const filters = [eq(agents.owner_id, human.id)];
    if (query.status) {
      filters.push(eq(agents.status, query.status));
    }
    if (query.framework) {
      filters.push(eq(agents.framework, query.framework));
    }
    if (query.cursor) {
      filters.push(lt(agents.id, query.cursor));
    }

    const rows = await db
      .select({
        id: agents.id,
        did: agents.did,
        name: agents.name,
        status: agents.status,
        expires_at: agents.expires_at,
      })
      .from(agents)
      .where(and(...filters))
      .orderBy(desc(agents.id))
      .limit(query.limit + 1);

    const hasNextPage = rows.length > query.limit;
    const pageRows = hasNextPage ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasNextPage
      ? (pageRows[pageRows.length - 1]?.id ?? null)
      : null;

    return c.json({
      agents: pageRows.map(mapAgentListRow),
      pagination: {
        limit: query.limit,
        nextCursor,
      },
    });
  });

  app.get("/v1/agents/:id/ownership", createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const agentId = parseAgentOwnershipPath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: agents.id,
      })
      .from(agents)
      .where(and(eq(agents.owner_id, human.id), eq(agents.id, agentId)))
      .limit(1);

    return c.json({
      ownsAgent: rows.length > 0,
    });
  });

  app.post(AGENT_REGISTRATION_CHALLENGE_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "AGENT_REGISTRATION_CHALLENGE_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const human = c.get("human");
    const challenge = buildAgentRegistrationChallenge({
      payload,
      ownerId: human.id,
      ownerDid: human.did,
      environment: config.ENVIRONMENT,
    });

    const db = createDb(c.env.DB);
    await db.insert(agent_registration_challenges).values({
      id: challenge.challenge.id,
      owner_id: challenge.challenge.ownerId,
      public_key: challenge.challenge.publicKey,
      nonce: challenge.challenge.nonce,
      status: challenge.challenge.status,
      expires_at: challenge.challenge.expiresAt,
      used_at: challenge.challenge.usedAt,
      created_at: challenge.challenge.createdAt,
      updated_at: challenge.challenge.updatedAt,
    });

    return c.json(challenge.response, 201);
  });

  app.post("/v1/agents", createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "AGENT_REGISTRATION_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const human = c.get("human");
    const parsedBody = parseAgentRegistrationBody(payload, config.ENVIRONMENT);
    const db = createDb(c.env.DB);

    const challenge = await findOwnedAgentRegistrationChallenge({
      db,
      ownerId: human.id,
      challengeId: parsedBody.challengeId,
    });

    if (!challenge) {
      throw new AppError({
        code: "AGENT_REGISTRATION_CHALLENGE_NOT_FOUND",
        message: exposeDetails
          ? "Registration challenge was not found"
          : "Request could not be processed",
        status: 400,
        expose: true,
      });
    }

    await verifyAgentRegistrationOwnershipProof({
      parsedBody,
      challenge: {
        id: challenge.id,
        ownerId: challenge.owner_id,
        publicKey: challenge.public_key,
        nonce: challenge.nonce,
        status: challenge.status,
        expiresAt: challenge.expires_at,
        usedAt: challenge.used_at,
      },
      ownerDid: human.did,
      environment: config.ENVIRONMENT,
    });
    const registration = buildAgentRegistrationFromParsed({
      parsedBody,
      ownerDid: human.did,
      issuer: resolvePublicRegistryIssuer({
        request: c.req.raw,
        config,
      }),
    });
    const signer = await resolveRegistrySigner(config);
    const ait = await signAIT({
      claims: registration.claims,
      signerKid: signer.signerKid,
      signerKeypair: signer.signerKeypair,
    });

    const initialAuth = await issueAgentAuth();
    const challengeUsedAt = nowIso();
    const applyRegistrationMutation = async (
      executor: typeof db,
      options: { rollbackOnAgentInsertFailure: boolean },
    ): Promise<void> => {
      try {
        const challengeUpdateResult = await executor
          .update(agent_registration_challenges)
          .set({
            status: "used",
            used_at: challengeUsedAt,
            updated_at: challengeUsedAt,
          })
          .where(
            and(
              eq(agent_registration_challenges.id, challenge.id),
              eq(agent_registration_challenges.owner_id, human.id),
              eq(agent_registration_challenges.status, "pending"),
            ),
          );

        const updatedRows = getMutationRowCount(challengeUpdateResult);
        if (updatedRows === 0) {
          throw new AppError({
            code: "AGENT_REGISTRATION_CHALLENGE_REPLAYED",
            message: exposeDetails
              ? "Registration challenge has already been used"
              : "Request could not be processed",
            status: 400,
            expose: true,
          });
        }

        if (
          typeof human.agentLimit === "number" &&
          Number.isFinite(human.agentLimit) &&
          human.agentLimit >= 0
        ) {
          const existingAgentCount = await countAgentsByOwner({
            db: executor,
            ownerId: human.id,
          });
          if (existingAgentCount >= human.agentLimit) {
            throw new AppError({
              code: "AGENT_REGISTRATION_LIMIT_REACHED",
              message: "Agent registration limit has been reached",
              status: 409,
              expose: true,
            });
          }
        }

        await executor.insert(agents).values({
          id: registration.agent.id,
          did: registration.agent.did,
          owner_id: human.id,
          name: registration.agent.name,
          framework: registration.agent.framework,
          public_key: registration.agent.publicKey,
          current_jti: registration.agent.currentJti,
          status: registration.agent.status,
          expires_at: registration.agent.expiresAt,
          created_at: registration.agent.createdAt,
          updated_at: registration.agent.updatedAt,
        });

        await executor.insert(agent_auth_sessions).values({
          id: initialAuth.sessionId,
          agent_id: registration.agent.id,
          refresh_key_hash: initialAuth.refreshTokenHash,
          refresh_key_prefix: initialAuth.refreshTokenPrefix,
          refresh_issued_at: initialAuth.refreshIssuedAt,
          refresh_expires_at: initialAuth.refreshExpiresAt,
          refresh_last_used_at: null,
          access_key_hash: initialAuth.accessTokenHash,
          access_key_prefix: initialAuth.accessTokenPrefix,
          access_issued_at: initialAuth.accessIssuedAt,
          access_expires_at: initialAuth.accessExpiresAt,
          access_last_used_at: null,
          status: "active",
          revoked_at: null,
          created_at: initialAuth.createdAt,
          updated_at: initialAuth.updatedAt,
        });

        await insertAgentAuthEvent({
          db: executor,
          agentId: registration.agent.id,
          sessionId: initialAuth.sessionId,
          eventType: "issued",
          createdAt: initialAuth.createdAt,
          metadata: {
            actor: "agent_registration",
          },
          eventBus: getEventBus(c.env),
          initiatedByAccountId: human.did,
        });
      } catch (error) {
        if (options.rollbackOnAgentInsertFailure) {
          try {
            await executor
              .delete(agent_auth_sessions)
              .where(eq(agent_auth_sessions.id, initialAuth.sessionId));
          } catch (rollbackError) {
            logger.error("registry.agent_registration_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
              stage: "auth_session_delete",
            });
          }

          try {
            await executor
              .delete(agents)
              .where(eq(agents.id, registration.agent.id));
          } catch (rollbackError) {
            logger.error("registry.agent_registration_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
              stage: "agent_delete",
            });
          }

          await executor
            .update(agent_registration_challenges)
            .set({
              status: "pending",
              used_at: null,
              updated_at: nowIso(),
            })
            .where(
              and(
                eq(agent_registration_challenges.id, challenge.id),
                eq(agent_registration_challenges.owner_id, human.id),
                eq(agent_registration_challenges.status, "used"),
              ),
            );
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyRegistrationMutation(tx as unknown as typeof db, {
          rollbackOnAgentInsertFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyRegistrationMutation(db, {
        rollbackOnAgentInsertFailure: true,
      });
    }

    return c.json(
      {
        agent: registration.agent,
        ait,
        agentAuth: toAgentAuthResponse({
          accessToken: initialAuth.accessToken,
          accessExpiresAt: initialAuth.accessExpiresAt,
          refreshToken: initialAuth.refreshToken,
          refreshExpiresAt: initialAuth.refreshExpiresAt,
        }),
      },
      201,
    );
  });

  app.delete("/v1/agents/:id", createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const agentId = parseAgentRevokePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const existingAgent = await findOwnedAgent({
      db,
      ownerId: human.id,
      agentId,
    });

    if (!existingAgent) {
      throw agentNotFoundError();
    }

    if (existingAgent.status === "revoked") {
      return c.body(null, 204);
    }

    const currentJti = requireCurrentJti({
      currentJti: existingAgent.current_jti,
      onInvalid: (reason) =>
        invalidAgentRevokeStateError({
          environment: config.ENVIRONMENT,
          reason: `${reason} for revocation`,
        }),
    });

    const existingSession = await findAgentAuthSessionByAgentId({
      db,
      agentId: existingAgent.id,
    });
    const revokedAt = nowIso();
    const applyRevokeMutation = async (executor: typeof db): Promise<void> => {
      await executor
        .update(agents)
        .set({
          status: "revoked",
          updated_at: revokedAt,
        })
        .where(eq(agents.id, existingAgent.id));

      await executor
        .insert(revocations)
        .values({
          id: generateUlid(nowUtcMs()),
          jti: currentJti,
          agent_id: existingAgent.id,
          reason: null,
          revoked_at: revokedAt,
        })
        .onConflictDoNothing({
          target: revocations.jti,
        });

      if (existingSession && existingSession.status === "active") {
        await executor
          .update(agent_auth_sessions)
          .set({
            status: "revoked",
            revoked_at: revokedAt,
            updated_at: revokedAt,
          })
          .where(
            and(
              eq(agent_auth_sessions.id, existingSession.id),
              eq(agent_auth_sessions.status, "active"),
            ),
          );

        await insertAgentAuthEvent({
          db: executor,
          agentId: existingAgent.id,
          sessionId: existingSession.id,
          eventType: "revoked",
          reason: "agent_revoked",
          metadata: {
            agentDid: existingAgent.did,
          },
          createdAt: revokedAt,
          eventBus: getEventBus(c.env),
          initiatedByAccountId: human.did,
        });
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyRevokeMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyRevokeMutation(db);
    }

    return c.body(null, 204);
  });

  app.post("/v1/agents/:id/reissue", createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const agentId = parseAgentRevokePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const existingAgent = await findOwnedAgent({
      db,
      ownerId: human.id,
      agentId,
    });

    if (!existingAgent) {
      throw agentNotFoundError();
    }

    if (existingAgent.status === "revoked") {
      throw invalidAgentReissueStateError({
        environment: config.ENVIRONMENT,
        field: "status",
        reason: "revoked agents cannot be reissued",
      });
    }

    const currentJti = requireCurrentJti({
      currentJti: existingAgent.current_jti,
      onInvalid: (reason) =>
        invalidAgentReissueStateError({
          environment: config.ENVIRONMENT,
          reason: `${reason} for reissue`,
        }),
    });

    const reissue = buildAgentReissue({
      id: existingAgent.id,
      did: existingAgent.did,
      ownerDid: human.did,
      name: existingAgent.name,
      framework: existingAgent.framework,
      publicKey: existingAgent.public_key,
      previousExpiresAt: existingAgent.expires_at,
      issuer: resolveRegistryIssuer(config),
    });
    const signer = await resolveRegistrySigner(config);
    const ait = await signAIT({
      claims: reissue.claims,
      signerKid: signer.signerKid,
      signerKeypair: signer.signerKeypair,
    });

    const revokedAt = nowIso();
    const applyReissueMutation = async (executor: typeof db): Promise<void> => {
      const updateResult = await executor
        .update(agents)
        .set({
          status: "active",
          current_jti: reissue.agent.currentJti,
          expires_at: reissue.agent.expiresAt,
          updated_at: reissue.agent.updatedAt,
        })
        .where(
          and(
            eq(agents.id, existingAgent.id),
            eq(agents.status, "active"),
            eq(agents.current_jti, currentJti),
          ),
        );

      const updatedRows = getMutationRowCount(updateResult);
      if (updatedRows === 0) {
        throw invalidAgentReissueStateError({
          environment: config.ENVIRONMENT,
          field: "currentJti",
          reason: "agent state changed during reissue; retry request",
        });
      }

      await executor
        .insert(revocations)
        .values({
          id: generateUlid(nowUtcMs()),
          jti: currentJti,
          agent_id: existingAgent.id,
          reason: "reissued",
          revoked_at: revokedAt,
        })
        .onConflictDoNothing({
          target: revocations.jti,
        });
    };

    try {
      await db.transaction(async (tx) => {
        await applyReissueMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyReissueMutation(db);
    }

    return c.json({ agent: reissue.agent, ait });
  });
}
