import {
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_VALIDATE_PATH,
} from "@clawdentity/protocol";
import {
  AppError,
  nowIso,
  nowUtcMs,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import {
  agentAuthRefreshConflictError,
  agentAuthRefreshRejectedError,
  issueAgentAuth,
  parseAgentAuthRefreshPayload,
  toAgentAuthResponse,
} from "../../agent-auth-lifecycle.js";
import {
  agentNotFoundError,
  parseAgentRevokePath,
} from "../../agent-revocation.js";
import {
  deriveAccessTokenLookupPrefix,
  deriveRefreshTokenLookupPrefix,
  hashAgentToken,
} from "../../auth/agent-auth-token.js";
import { verifyAgentClawRequest } from "../../auth/agent-claw-auth.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import { constantTimeEqual } from "../../auth/api-key-token.js";
import { createDb } from "../../db/client.js";
import { agent_auth_sessions } from "../../db/schema.js";
import type { RegistryRouteDependencies } from "../constants.js";
import { DB_MUTATION_OPERATION } from "../helpers/db-mutation-operations.js";
import {
  findAgentAuthSessionByAgentId,
  findOwnedAgent,
  findOwnedAgentByDid,
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
} from "../helpers/db-queries.js";
import { insertAgentAuthEvent } from "../helpers/event-bus.js";
import {
  isIsoExpired,
  parseAgentAccessHeaderToken,
  parseAgentAuthValidatePayload,
} from "../helpers/parsers.js";

export function registerAgentAuthRoutes(
  input: RegistryRouteDependencies & {
    agentAuthRefreshRateLimit: MiddlewareHandler;
    agentAuthValidateRateLimit: MiddlewareHandler;
  },
): void {
  const {
    app,
    getConfig,
    getEventBus,
    agentAuthRefreshRateLimit,
    agentAuthValidateRateLimit,
  } = input;

  app.post(AGENT_AUTH_REFRESH_PATH, agentAuthRefreshRateLimit, async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);
    const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());

    let payload: unknown;
    try {
      const rawBody = new TextDecoder().decode(bodyBytes);
      payload = rawBody.trim().length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      throw new AppError({
        code: "AGENT_AUTH_REFRESH_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseAgentAuthRefreshPayload({
      payload,
      environment: config.ENVIRONMENT,
    });
    const claims = await verifyAgentClawRequest({
      config,
      request: c.req.raw,
      bodyBytes,
    });
    const nowMillis = nowUtcMs();
    const db = createDb(c.env.DB);
    const existingAgent = await findOwnedAgentByDid({
      db,
      did: claims.sub,
    });

    if (!existingAgent || existingAgent.status !== "active") {
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_INVALID",
        message: "Agent auth refresh token is invalid",
      });
    }

    if (existingAgent.current_jti !== claims.jti) {
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_INVALID",
        message: "Agent auth refresh token is invalid",
      });
    }

    const existingSession = await findAgentAuthSessionByAgentId({
      db,
      agentId: existingAgent.id,
    });

    if (!existingSession) {
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_INVALID",
        message: "Agent auth refresh token is invalid",
      });
    }

    if (existingSession.status !== "active") {
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_REVOKED",
        message: "Agent auth refresh token is revoked",
      });
    }

    const refreshPrefix = deriveRefreshTokenLookupPrefix(
      parsedPayload.refreshToken,
    );
    const refreshHash = await hashAgentToken(parsedPayload.refreshToken);
    const refreshTokenMatches =
      existingSession.refresh_key_prefix === refreshPrefix &&
      constantTimeEqual(existingSession.refresh_key_hash, refreshHash);

    if (!refreshTokenMatches) {
      await insertAgentAuthEvent({
        db,
        agentId: existingAgent.id,
        sessionId: existingSession.id,
        eventType: "refresh_rejected",
        reason: "invalid_refresh_token",
        eventBus: getEventBus(c.env),
        initiatedByAccountId: claims.ownerDid,
      });
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_INVALID",
        message: "Agent auth refresh token is invalid",
      });
    }

    if (isIsoExpired(existingSession.refresh_expires_at, nowMillis)) {
      const revokedAt = nowIso();
      await db
        .update(agent_auth_sessions)
        .set({
          status: "revoked",
          revoked_at: revokedAt,
          updated_at: revokedAt,
        })
        .where(eq(agent_auth_sessions.id, existingSession.id));
      await insertAgentAuthEvent({
        db,
        agentId: existingAgent.id,
        sessionId: existingSession.id,
        eventType: "revoked",
        reason: "refresh_token_expired",
        createdAt: revokedAt,
        eventBus: getEventBus(c.env),
        initiatedByAccountId: claims.ownerDid,
      });
      throw agentAuthRefreshRejectedError({
        code: "AGENT_AUTH_REFRESH_EXPIRED",
        message: "Agent auth refresh token is expired",
      });
    }

    const rotatedAuth = await issueAgentAuth({
      nowMs: nowMillis,
    });
    const refreshedAt = nowIso();
    const applyRefreshMutation = async (executor: typeof db): Promise<void> => {
      const updateResult = await executor
        .update(agent_auth_sessions)
        .set({
          refresh_key_hash: rotatedAuth.refreshTokenHash,
          refresh_key_prefix: rotatedAuth.refreshTokenPrefix,
          refresh_issued_at: rotatedAuth.refreshIssuedAt,
          refresh_expires_at: rotatedAuth.refreshExpiresAt,
          refresh_last_used_at: refreshedAt,
          access_key_hash: rotatedAuth.accessTokenHash,
          access_key_prefix: rotatedAuth.accessTokenPrefix,
          access_issued_at: rotatedAuth.accessIssuedAt,
          access_expires_at: rotatedAuth.accessExpiresAt,
          access_last_used_at: null,
          status: "active",
          revoked_at: null,
          updated_at: refreshedAt,
        })
        .where(
          and(
            eq(agent_auth_sessions.id, existingSession.id),
            eq(agent_auth_sessions.status, "active"),
            eq(agent_auth_sessions.refresh_key_hash, refreshHash),
          ),
        );

      const updatedRows = getMutationRowCount({
        result: updateResult,
        operation: DB_MUTATION_OPERATION.AGENT_AUTH_REFRESH_SESSION_UPDATE,
      });
      if (updatedRows === 0) {
        throw agentAuthRefreshConflictError();
      }

      await insertAgentAuthEvent({
        db: executor,
        agentId: existingAgent.id,
        sessionId: existingSession.id,
        eventType: "refreshed",
        createdAt: refreshedAt,
        eventBus: getEventBus(c.env),
        initiatedByAccountId: claims.ownerDid,
      });
    };

    try {
      await db.transaction(async (tx) => {
        await applyRefreshMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyRefreshMutation(db);
    }

    return c.json({
      agentAuth: toAgentAuthResponse({
        accessToken: rotatedAuth.accessToken,
        accessExpiresAt: rotatedAuth.accessExpiresAt,
        refreshToken: rotatedAuth.refreshToken,
        refreshExpiresAt: rotatedAuth.refreshExpiresAt,
      }),
    });
  });

  app.post(AGENT_AUTH_VALIDATE_PATH, agentAuthValidateRateLimit, async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_INVALID",
        message: "Validation payload is invalid",
        status: 400,
        expose: true,
      });
    }

    const parsedPayload = parseAgentAuthValidatePayload(payload);
    const accessToken = parseAgentAccessHeaderToken(
      c.req.header("x-claw-agent-access"),
    );

    const db = createDb(c.env.DB);
    const existingAgent = await findOwnedAgentByDid({
      db,
      did: parsedPayload.agentDid,
    });
    if (
      !existingAgent ||
      existingAgent.status !== "active" ||
      existingAgent.current_jti !== parsedPayload.aitJti
    ) {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
        message: "Agent access token is invalid",
        status: 401,
        expose: true,
      });
    }

    const existingSession = await findAgentAuthSessionByAgentId({
      db,
      agentId: existingAgent.id,
    });
    if (!existingSession || existingSession.status !== "active") {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
        message: "Agent access token is invalid",
        status: 401,
        expose: true,
      });
    }

    const nowMillis = nowUtcMs();
    if (isIsoExpired(existingSession.access_expires_at, nowMillis)) {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_EXPIRED",
        message: "Agent access token is expired",
        status: 401,
        expose: true,
      });
    }

    const accessTokenPrefix = deriveAccessTokenLookupPrefix(accessToken);
    const accessTokenHash = await hashAgentToken(accessToken);
    const accessTokenMatches =
      existingSession.access_key_prefix === accessTokenPrefix &&
      constantTimeEqual(existingSession.access_key_hash, accessTokenHash);
    if (!accessTokenMatches) {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
        message: "Agent access token is invalid",
        status: 401,
        expose: true,
      });
    }

    const accessLastUsedAt = nowIso();
    const updateResult = await db
      .update(agent_auth_sessions)
      .set({
        access_last_used_at: accessLastUsedAt,
        updated_at: accessLastUsedAt,
      })
      .where(
        and(
          eq(agent_auth_sessions.id, existingSession.id),
          eq(agent_auth_sessions.status, "active"),
          eq(agent_auth_sessions.access_key_hash, accessTokenHash),
        ),
      );

    const updatedRows = getMutationRowCount({
      result: updateResult,
      operation: DB_MUTATION_OPERATION.AGENT_AUTH_VALIDATE_SESSION_TOUCH,
    });
    if (updatedRows === 0) {
      throw new AppError({
        code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
        message: "Agent access token is invalid",
        status: 401,
        expose: true,
      });
    }

    return c.body(null, 204);
  });

  app.delete("/v1/agents/:id/auth/revoke", createApiKeyAuth(), async (c) => {
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

    const existingSession = await findAgentAuthSessionByAgentId({
      db,
      agentId: existingAgent.id,
    });
    if (!existingSession || existingSession.status === "revoked") {
      return c.body(null, 204);
    }

    const revokedAt = nowIso();
    const applyAuthRevokeMutation = async (
      executor: typeof db,
    ): Promise<void> => {
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
        reason: "owner_auth_revoke",
        createdAt: revokedAt,
        eventBus: getEventBus(c.env),
        initiatedByAccountId: human.did,
      });
    };

    try {
      await db.transaction(async (tx) => {
        await applyAuthRevokeMutation(tx as unknown as typeof db);
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyAuthRevokeMutation(db);
    }

    return c.body(null, 204);
  });
}
