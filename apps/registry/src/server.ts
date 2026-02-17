import {
  ADMIN_BOOTSTRAP_PATH,
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_VALIDATE_PATH,
  AGENT_REGISTRATION_CHALLENGE_PATH,
  generateUlid,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  ME_API_KEYS_PATH,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  AppError,
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  nowIso,
  parseRegistryConfig,
  type RegistryConfig,
  shouldExposeVerboseErrors,
  signAIT,
  signCRL,
} from "@clawdentity/sdk";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { Hono } from "hono";
import { parseAdminBootstrapPayload } from "./admin-bootstrap.js";
import {
  agentAuthRefreshConflictError,
  agentAuthRefreshRejectedError,
  issueAgentAuth,
  parseAgentAuthRefreshPayload,
  toAgentAuthResponse,
} from "./agent-auth-lifecycle.js";
import { mapAgentListRow, parseAgentListQuery } from "./agent-list.js";
import { parseAgentOwnershipPath } from "./agent-ownership.js";
import {
  buildAgentRegistrationChallenge,
  buildAgentRegistrationFromParsed,
  buildAgentReissue,
  parseAgentRegistrationBody,
  resolveRegistryIssuer,
  verifyAgentRegistrationOwnershipProof,
} from "./agent-registration.js";
import {
  agentResolveNotFoundError,
  mapResolvedAgentRow,
  parseAgentResolvePath,
} from "./agent-resolve.js";
import {
  agentNotFoundError,
  invalidAgentReissueStateError,
  invalidAgentRevokeStateError,
  parseAgentRevokePath,
} from "./agent-revocation.js";
import {
  apiKeyNotFoundError,
  mapApiKeyMetadataRow,
  parseApiKeyCreatePayload,
  parseApiKeyRevokePath,
} from "./api-key-lifecycle.js";
import {
  deriveAccessTokenLookupPrefix,
  deriveRefreshTokenLookupPrefix,
  hashAgentToken,
  parseAccessToken,
} from "./auth/agent-auth-token.js";
import { verifyAgentClawRequest } from "./auth/agent-claw-auth.js";
import {
  type AuthenticatedHuman,
  createApiKeyAuth,
} from "./auth/api-key-auth.js";
import {
  constantTimeEqual,
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "./auth/api-key-token.js";
import { createDb } from "./db/client.js";
import {
  agent_auth_events,
  agent_auth_sessions,
  agent_registration_challenges,
  agents,
  api_keys,
  humans,
  invites,
  revocations,
} from "./db/schema.js";
import {
  generateInviteCode,
  inviteCreateForbiddenError,
  inviteRedeemAlreadyUsedError,
  inviteRedeemCodeInvalidError,
  inviteRedeemExpiredError,
  parseInviteCreatePayload,
  parseInviteRedeemPayload,
} from "./invite-lifecycle.js";
import {
  AGENT_AUTH_REFRESH_RATE_LIMIT_MAX_REQUESTS,
  AGENT_AUTH_REFRESH_RATE_LIMIT_WINDOW_MS,
  AGENT_AUTH_VALIDATE_RATE_LIMIT_MAX_REQUESTS,
  AGENT_AUTH_VALIDATE_RATE_LIMIT_WINDOW_MS,
  CRL_RATE_LIMIT_MAX_REQUESTS,
  CRL_RATE_LIMIT_WINDOW_MS,
  createInMemoryRateLimit,
  RESOLVE_RATE_LIMIT_MAX_REQUESTS,
  RESOLVE_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";
import { resolveRegistrySigner } from "./registry-signer.js";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  APP_VERSION?: string;
  BOOTSTRAP_SECRET?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_KEYS?: string;
};
const logger = createLogger({ service: "registry" });
const REGISTRY_CACHE_MAX_AGE_SECONDS = 300;
const REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 60;
const REGISTRY_KEY_CACHE_CONTROL = `public, max-age=${REGISTRY_CACHE_MAX_AGE_SECONDS}, s-maxage=${REGISTRY_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS}`;
const REGISTRY_CRL_CACHE_CONTROL = `public, max-age=${REGISTRY_CACHE_MAX_AGE_SECONDS}, s-maxage=${REGISTRY_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS}`;
const CRL_EXPIRY_SAFETY_BUFFER_SECONDS = 30;
const CRL_TTL_SECONDS =
  REGISTRY_CACHE_MAX_AGE_SECONDS +
  REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS +
  CRL_EXPIRY_SAFETY_BUFFER_SECONDS;
// Deterministic bootstrap identity guarantees one-time admin creation under races.
const BOOTSTRAP_ADMIN_HUMAN_ID = "00000000000000000000000000";

type OwnedAgent = {
  id: string;
  did: string;
  name: string;
  framework: string | null;
  public_key: string;
  status: "active" | "revoked";
  expires_at: string | null;
  current_jti: string | null;
};

type OwnedAgentRegistrationChallenge = {
  id: string;
  owner_id: string;
  public_key: string;
  nonce: string;
  status: "pending" | "used";
  expires_at: string;
  used_at: string | null;
};

type OwnedAgentAuthSession = {
  id: string;
  agent_id: string;
  refresh_key_hash: string;
  refresh_key_prefix: string;
  refresh_issued_at: string;
  refresh_expires_at: string;
  refresh_last_used_at: string | null;
  access_key_hash: string;
  access_key_prefix: string;
  access_issued_at: string;
  access_expires_at: string;
  access_last_used_at: string | null;
  status: "active" | "revoked";
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

type InviteRow = {
  id: string;
  code: string;
  created_by: string;
  redeemed_by: string | null;
  expires_at: string | null;
  created_at: string;
};

type CrlSnapshotRow = {
  id: string;
  jti: string;
  reason: string | null;
  revoked_at: string;
  agent_did: string;
};

type RegistryRateLimitRuntimeOptions = {
  nowMs?: () => number;
  resolveMaxRequests?: number;
  resolveWindowMs?: number;
  crlMaxRequests?: number;
  crlWindowMs?: number;
  agentAuthRefreshMaxRequests?: number;
  agentAuthRefreshWindowMs?: number;
  agentAuthValidateMaxRequests?: number;
  agentAuthValidateWindowMs?: number;
};

type CreateRegistryAppOptions = {
  rateLimit?: RegistryRateLimitRuntimeOptions;
};

function crlBuildError(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  message: string;
  details?: {
    fieldErrors: Record<string, string[]>;
    formErrors: string[];
  };
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "CRL_BUILD_FAILED",
    message: exposeDetails
      ? options.message
      : "CRL snapshot could not be generated",
    status: 500,
    expose: exposeDetails,
    details: exposeDetails ? options.details : undefined,
  });
}

function parseRevokedAtSeconds(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  revocationId: string;
  revokedAtIso: string;
}): number {
  const epochMillis = Date.parse(options.revokedAtIso);
  if (!Number.isFinite(epochMillis)) {
    throw crlBuildError({
      environment: options.environment,
      message: "CRL revocation timestamp is invalid",
      details: {
        fieldErrors: {
          revokedAt: [
            `revocation ${options.revocationId} has invalid revoked_at timestamp`,
          ],
        },
        formErrors: [],
      },
    });
  }

  return Math.floor(epochMillis / 1000);
}

function buildCrlClaims(input: {
  rows: CrlSnapshotRow[];
  environment: RegistryConfig["ENVIRONMENT"];
  issuer: string;
  nowSeconds: number;
}) {
  return {
    iss: input.issuer,
    jti: generateUlid(Date.now()),
    iat: input.nowSeconds,
    exp: input.nowSeconds + CRL_TTL_SECONDS,
    revocations: input.rows.map((row) => {
      const base = {
        jti: row.jti,
        agentDid: row.agent_did,
        revokedAt: parseRevokedAtSeconds({
          environment: input.environment,
          revocationId: row.id,
          revokedAtIso: row.revoked_at,
        }),
      };

      if (typeof row.reason === "string" && row.reason.length > 0) {
        return {
          ...base,
          reason: row.reason,
        };
      }

      return base;
    }),
  };
}

async function findOwnedAgent(input: {
  db: ReturnType<typeof createDb>;
  ownerId: string;
  agentId: string;
}): Promise<OwnedAgent | undefined> {
  const rows = await input.db
    .select({
      id: agents.id,
      did: agents.did,
      name: agents.name,
      framework: agents.framework,
      public_key: agents.public_key,
      status: agents.status,
      expires_at: agents.expires_at,
      current_jti: agents.current_jti,
    })
    .from(agents)
    .where(
      and(eq(agents.owner_id, input.ownerId), eq(agents.id, input.agentId)),
    )
    .limit(1);

  return rows[0];
}

async function findAgentAuthSessionByAgentId(input: {
  db: ReturnType<typeof createDb>;
  agentId: string;
}): Promise<OwnedAgentAuthSession | undefined> {
  const rows = await input.db
    .select({
      id: agent_auth_sessions.id,
      agent_id: agent_auth_sessions.agent_id,
      refresh_key_hash: agent_auth_sessions.refresh_key_hash,
      refresh_key_prefix: agent_auth_sessions.refresh_key_prefix,
      refresh_issued_at: agent_auth_sessions.refresh_issued_at,
      refresh_expires_at: agent_auth_sessions.refresh_expires_at,
      refresh_last_used_at: agent_auth_sessions.refresh_last_used_at,
      access_key_hash: agent_auth_sessions.access_key_hash,
      access_key_prefix: agent_auth_sessions.access_key_prefix,
      access_issued_at: agent_auth_sessions.access_issued_at,
      access_expires_at: agent_auth_sessions.access_expires_at,
      access_last_used_at: agent_auth_sessions.access_last_used_at,
      status: agent_auth_sessions.status,
      revoked_at: agent_auth_sessions.revoked_at,
      created_at: agent_auth_sessions.created_at,
      updated_at: agent_auth_sessions.updated_at,
    })
    .from(agent_auth_sessions)
    .where(eq(agent_auth_sessions.agent_id, input.agentId))
    .limit(1);

  return rows[0];
}

async function findOwnedAgentByDid(input: {
  db: ReturnType<typeof createDb>;
  did: string;
}): Promise<OwnedAgent | undefined> {
  const rows = await input.db
    .select({
      id: agents.id,
      did: agents.did,
      name: agents.name,
      framework: agents.framework,
      public_key: agents.public_key,
      status: agents.status,
      expires_at: agents.expires_at,
      current_jti: agents.current_jti,
    })
    .from(agents)
    .where(eq(agents.did, input.did))
    .limit(1);

  return rows[0];
}

async function findOwnedAgentRegistrationChallenge(input: {
  db: ReturnType<typeof createDb>;
  ownerId: string;
  challengeId: string;
}): Promise<OwnedAgentRegistrationChallenge | undefined> {
  const rows = await input.db
    .select({
      id: agent_registration_challenges.id,
      owner_id: agent_registration_challenges.owner_id,
      public_key: agent_registration_challenges.public_key,
      nonce: agent_registration_challenges.nonce,
      status: agent_registration_challenges.status,
      expires_at: agent_registration_challenges.expires_at,
      used_at: agent_registration_challenges.used_at,
    })
    .from(agent_registration_challenges)
    .where(
      and(
        eq(agent_registration_challenges.owner_id, input.ownerId),
        eq(agent_registration_challenges.id, input.challengeId),
      ),
    )
    .limit(1);

  return rows[0];
}

async function findInviteByCode(input: {
  db: ReturnType<typeof createDb>;
  code: string;
}): Promise<InviteRow | undefined> {
  const rows = await input.db
    .select({
      id: invites.id,
      code: invites.code,
      created_by: invites.created_by,
      redeemed_by: invites.redeemed_by,
      expires_at: invites.expires_at,
      created_at: invites.created_at,
    })
    .from(invites)
    .where(eq(invites.code, input.code))
    .limit(1);

  return rows[0];
}

async function findInviteById(input: {
  db: ReturnType<typeof createDb>;
  id: string;
}): Promise<InviteRow | undefined> {
  const rows = await input.db
    .select({
      id: invites.id,
      code: invites.code,
      created_by: invites.created_by,
      redeemed_by: invites.redeemed_by,
      expires_at: invites.expires_at,
      created_at: invites.created_at,
    })
    .from(invites)
    .where(eq(invites.id, input.id))
    .limit(1);

  return rows[0];
}

function isInviteExpired(input: {
  expiresAt: string | null;
  nowMillis: number;
}) {
  if (typeof input.expiresAt !== "string") {
    return false;
  }

  const expiresAtMillis = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMillis)) {
    return true;
  }

  return expiresAtMillis <= input.nowMillis;
}

function isIsoExpired(expiresAtIso: string, nowMillis: number): boolean {
  const parsed = Date.parse(expiresAtIso);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return parsed <= nowMillis;
}

function parseAgentAuthValidatePayload(payload: unknown): {
  agentDid: string;
  aitJti: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_INVALID",
      message: "Validation payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const value = payload as Record<string, unknown>;
  const agentDid =
    typeof value.agentDid === "string" ? value.agentDid.trim() : "";
  const aitJti = typeof value.aitJti === "string" ? value.aitJti.trim() : "";

  if (agentDid.length === 0 || aitJti.length === 0) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_INVALID",
      message: "Validation payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return {
    agentDid,
    aitJti,
  };
}

function parseAgentAccessHeaderToken(token: string | undefined): string {
  try {
    return parseAccessToken(token);
  } catch {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
      message: "Agent access token is invalid",
      status: 401,
      expose: true,
    });
  }
}

async function insertAgentAuthEvent(input: {
  db: ReturnType<typeof createDb>;
  agentId: string;
  sessionId: string;
  eventType: "issued" | "refreshed" | "revoked" | "refresh_rejected";
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): Promise<void> {
  await input.db.insert(agent_auth_events).values({
    id: generateUlid(Date.now()),
    agent_id: input.agentId,
    session_id: input.sessionId,
    event_type: input.eventType,
    reason: input.reason ?? null,
    metadata_json:
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    created_at: input.createdAt ?? nowIso(),
  });
}

async function resolveInviteRedeemStateError(input: {
  db: ReturnType<typeof createDb>;
  inviteId: string;
  nowMillis: number;
}): Promise<AppError> {
  const latestInvite = await findInviteById({
    db: input.db,
    id: input.inviteId,
  });

  if (!latestInvite) {
    return inviteRedeemCodeInvalidError();
  }

  if (latestInvite.redeemed_by !== null) {
    return inviteRedeemAlreadyUsedError();
  }

  if (
    isInviteExpired({
      expiresAt: latestInvite.expires_at,
      nowMillis: input.nowMillis,
    })
  ) {
    return inviteRedeemExpiredError();
  }

  return inviteRedeemCodeInvalidError();
}

function requireCurrentJti(input: {
  currentJti: string | null;
  onInvalid: (reason: string) => AppError;
}): string {
  if (typeof input.currentJti !== "string" || input.currentJti.length === 0) {
    throw input.onInvalid("agent.current_jti is required");
  }

  return input.currentJti;
}

function isUnsupportedLocalTransactionError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Failed query: begin")
  );
}

function getMutationRowCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const directChanges = (result as { changes?: unknown }).changes;
  if (typeof directChanges === "number") {
    return directChanges;
  }

  const rowsAffected = (result as { rowsAffected?: unknown }).rowsAffected;
  if (typeof rowsAffected === "number") {
    return rowsAffected;
  }

  const metaChanges = (result as { meta?: { changes?: unknown } }).meta
    ?.changes;
  if (typeof metaChanges === "number") {
    return metaChanges;
  }

  return undefined;
}

function requireBootstrapSecret(bootstrapSecret: string | undefined): string {
  if (typeof bootstrapSecret === "string" && bootstrapSecret.length > 0) {
    return bootstrapSecret;
  }

  throw new AppError({
    code: "ADMIN_BOOTSTRAP_DISABLED",
    message: "Admin bootstrap is disabled",
    status: 503,
    expose: true,
  });
}

function parseBootstrapSecretHeader(headerValue: string | undefined): string {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_UNAUTHORIZED",
      message: "Bootstrap secret is required",
      status: 401,
      expose: true,
    });
  }

  return headerValue.trim();
}

function assertBootstrapSecretAuthorized(input: {
  provided: string;
  expected: string;
}): void {
  if (!constantTimeEqual(input.provided, input.expected)) {
    throw new AppError({
      code: "ADMIN_BOOTSTRAP_UNAUTHORIZED",
      message: "Bootstrap secret is invalid",
      status: 401,
      expose: true,
    });
  }
}

function adminBootstrapAlreadyCompletedError(): AppError {
  return new AppError({
    code: "ADMIN_BOOTSTRAP_ALREADY_COMPLETED",
    message: "Admin bootstrap has already completed",
    status: 409,
    expose: true,
  });
}

function createRegistryApp(options: CreateRegistryAppOptions = {}) {
  let cachedConfig: RegistryConfig | undefined;

  function getConfig(bindings: Bindings): RegistryConfig {
    if (cachedConfig) {
      return cachedConfig;
    }

    cachedConfig = parseRegistryConfig(bindings);
    return cachedConfig;
  }

  const app = new Hono<{
    Bindings: Bindings;
    Variables: { requestId: string; human: AuthenticatedHuman };
  }>();
  const rateLimitOptions = options.rateLimit;
  const resolveRateLimit = createInMemoryRateLimit({
    bucketKey: "resolve",
    maxRequests:
      rateLimitOptions?.resolveMaxRequests ?? RESOLVE_RATE_LIMIT_MAX_REQUESTS,
    windowMs: rateLimitOptions?.resolveWindowMs ?? RESOLVE_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const crlRateLimit = createInMemoryRateLimit({
    bucketKey: "crl",
    maxRequests:
      rateLimitOptions?.crlMaxRequests ?? CRL_RATE_LIMIT_MAX_REQUESTS,
    windowMs: rateLimitOptions?.crlWindowMs ?? CRL_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const agentAuthRefreshRateLimit = createInMemoryRateLimit({
    bucketKey: "agent_auth_refresh",
    maxRequests:
      rateLimitOptions?.agentAuthRefreshMaxRequests ??
      AGENT_AUTH_REFRESH_RATE_LIMIT_MAX_REQUESTS,
    windowMs:
      rateLimitOptions?.agentAuthRefreshWindowMs ??
      AGENT_AUTH_REFRESH_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });
  const agentAuthValidateRateLimit = createInMemoryRateLimit({
    bucketKey: "agent_auth_validate",
    maxRequests:
      rateLimitOptions?.agentAuthValidateMaxRequests ??
      AGENT_AUTH_VALIDATE_RATE_LIMIT_MAX_REQUESTS,
    windowMs:
      rateLimitOptions?.agentAuthValidateWindowMs ??
      AGENT_AUTH_VALIDATE_RATE_LIMIT_WINDOW_MS,
    nowMs: rateLimitOptions?.nowMs,
  });

  app.use("*", createRequestContextMiddleware());
  app.use("*", createRequestLoggingMiddleware(logger));
  app.onError(createHonoErrorHandler(logger));

  app.get("/health", (c) => {
    const config = getConfig(c.env);
    return c.json({
      status: "ok",
      version: config.APP_VERSION ?? "0.0.0",
      environment: config.ENVIRONMENT,
    });
  });

  app.post(ADMIN_BOOTSTRAP_PATH, async (c) => {
    const config = getConfig(c.env);
    const expectedBootstrapSecret = requireBootstrapSecret(
      config.BOOTSTRAP_SECRET,
    );
    const providedBootstrapSecret = parseBootstrapSecretHeader(
      c.req.header("x-bootstrap-secret"),
    );
    assertBootstrapSecretAuthorized({
      provided: providedBootstrapSecret,
      expected: expectedBootstrapSecret,
    });

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "ADMIN_BOOTSTRAP_INVALID",
        message: "Request body must be valid JSON",
        status: 400,
        expose: true,
      });
    }

    const bootstrapPayload = parseAdminBootstrapPayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const db = createDb(c.env.DB);
    const activeAdminRows = await db
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.role, "admin"))
      .limit(1);
    if (activeAdminRows.length > 0) {
      throw adminBootstrapAlreadyCompletedError();
    }

    const humanId = BOOTSTRAP_ADMIN_HUMAN_ID;
    const humanDid = makeHumanDid(humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(Date.now() + 1);
    const createdAt = nowIso();

    const applyBootstrapMutation = async (
      executor: typeof db,
      options: { rollbackOnApiKeyFailure: boolean },
    ): Promise<void> => {
      const insertAdminResult = await executor
        .insert(humans)
        .values({
          id: humanId,
          did: humanDid,
          display_name: bootstrapPayload.displayName,
          role: "admin",
          status: "active",
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflictDoNothing({
          target: humans.id,
        });

      const insertedRows = getMutationRowCount(insertAdminResult);
      if (insertedRows === 0) {
        throw adminBootstrapAlreadyCompletedError();
      }

      try {
        await executor.insert(api_keys).values({
          id: apiKeyId,
          human_id: humanId,
          key_hash: apiKeyHash,
          key_prefix: apiKeyPrefix,
          name: bootstrapPayload.apiKeyName,
          status: "active",
          created_at: createdAt,
          last_used_at: null,
        });
      } catch (error) {
        if (options.rollbackOnApiKeyFailure) {
          try {
            await executor.delete(humans).where(eq(humans.id, humanId));
          } catch (rollbackError) {
            logger.error("registry.admin_bootstrap_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
            });
          }
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyBootstrapMutation(tx as unknown as typeof db, {
          rollbackOnApiKeyFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyBootstrapMutation(db, {
        rollbackOnApiKeyFailure: true,
      });
    }

    return c.json(
      {
        human: {
          id: humanId,
          did: humanDid,
          displayName: bootstrapPayload.displayName,
          role: "admin",
          status: "active",
        },
        apiKey: {
          id: apiKeyId,
          name: bootstrapPayload.apiKeyName,
          token: apiKeyToken,
        },
      },
      201,
    );
  });

  app.get("/.well-known/claw-keys.json", (c) => {
    const config = getConfig(c.env);
    return c.json(
      {
        keys: config.REGISTRY_SIGNING_KEYS ?? [],
      },
      200,
      {
        "Cache-Control": REGISTRY_KEY_CACHE_CONTROL,
      },
    );
  });

  app.get("/v1/crl", crlRateLimit, async (c) => {
    const config = getConfig(c.env);
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: revocations.id,
        jti: revocations.jti,
        reason: revocations.reason,
        revoked_at: revocations.revoked_at,
        agent_did: agents.did,
      })
      .from(revocations)
      .innerJoin(agents, eq(revocations.agent_id, agents.id))
      .orderBy(desc(revocations.revoked_at), desc(revocations.id));

    if (rows.length === 0) {
      throw new AppError({
        code: "CRL_NOT_FOUND",
        message: "CRL snapshot is not available",
        status: 404,
        expose: true,
      });
    }

    const signer = await resolveRegistrySigner(config);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims = buildCrlClaims({
      rows,
      environment: config.ENVIRONMENT,
      issuer: resolveRegistryIssuer(config.ENVIRONMENT),
      nowSeconds,
    });
    const crl = await signCRL({
      claims,
      signerKid: signer.signerKid,
      signerKeypair: signer.signerKeypair,
    });

    return c.json({ crl }, 200, {
      "Cache-Control": REGISTRY_CRL_CACHE_CONTROL,
    });
  });

  app.get("/v1/resolve/:id", resolveRateLimit, async (c) => {
    const config = getConfig(c.env);
    const id = parseAgentResolvePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        did: agents.did,
        name: agents.name,
        framework: agents.framework,
        status: agents.status,
        owner_did: humans.did,
      })
      .from(agents)
      .innerJoin(humans, eq(agents.owner_id, humans.id))
      .where(eq(agents.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw agentResolveNotFoundError();
    }

    return c.json(mapResolvedAgentRow(row));
  });

  app.get("/v1/me", createApiKeyAuth(), (c) => {
    return c.json({ human: c.get("human") });
  });

  app.post(INVITES_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "INVITE_CREATE_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const human = c.get("human");
    if (human.role !== "admin") {
      throw inviteCreateForbiddenError();
    }

    const parsedPayload = parseInviteCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
      now: new Date(),
    });

    const inviteId = generateUlid(Date.now());
    const inviteCode = generateInviteCode();
    const createdAt = nowIso();
    const db = createDb(c.env.DB);
    await db.insert(invites).values({
      id: inviteId,
      code: inviteCode,
      created_by: human.id,
      redeemed_by: null,
      agent_id: null,
      expires_at: parsedPayload.expiresAt,
      created_at: createdAt,
    });

    return c.json(
      {
        invite: {
          id: inviteId,
          code: inviteCode,
          createdBy: human.id,
          expiresAt: parsedPayload.expiresAt,
          createdAt,
        },
      },
      201,
    );
  });

  app.post(INVITES_REDEEM_PATH, async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "INVITE_REDEEM_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseInviteRedeemPayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const db = createDb(c.env.DB);
    const invite = await findInviteByCode({
      db,
      code: parsedPayload.code,
    });

    if (!invite) {
      throw inviteRedeemCodeInvalidError();
    }

    const nowMillis = Date.now();
    if (invite.redeemed_by !== null) {
      throw inviteRedeemAlreadyUsedError();
    }

    if (
      isInviteExpired({
        expiresAt: invite.expires_at,
        nowMillis,
      })
    ) {
      throw inviteRedeemExpiredError();
    }

    const humanId = generateUlid(nowMillis);
    const humanDid = makeHumanDid(humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowMillis + 1);
    const createdAt = nowIso();

    const applyRedeemMutation = async (
      executor: typeof db,
      options: { rollbackOnFailure: boolean },
    ): Promise<void> => {
      await executor.insert(humans).values({
        id: humanId,
        did: humanDid,
        display_name: parsedPayload.displayName,
        role: "user",
        status: "active",
        created_at: createdAt,
        updated_at: createdAt,
      });

      let inviteRedeemed = false;
      try {
        const inviteUpdateResult = await executor
          .update(invites)
          .set({
            redeemed_by: humanId,
          })
          .where(and(eq(invites.id, invite.id), isNull(invites.redeemed_by)));

        const updatedRows = getMutationRowCount(inviteUpdateResult);
        if (updatedRows === 0) {
          throw await resolveInviteRedeemStateError({
            db: executor,
            inviteId: invite.id,
            nowMillis,
          });
        }
        inviteRedeemed = true;

        await executor.insert(api_keys).values({
          id: apiKeyId,
          human_id: humanId,
          key_hash: apiKeyHash,
          key_prefix: apiKeyPrefix,
          name: parsedPayload.apiKeyName,
          status: "active",
          created_at: createdAt,
          last_used_at: null,
        });
      } catch (error) {
        if (options.rollbackOnFailure) {
          if (inviteRedeemed) {
            try {
              await executor
                .update(invites)
                .set({
                  redeemed_by: null,
                })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    eq(invites.redeemed_by, humanId),
                  ),
                );
            } catch (rollbackError) {
              logger.error("registry.invite_redeem_rollback_failed", {
                rollbackErrorName:
                  rollbackError instanceof Error
                    ? rollbackError.name
                    : "unknown",
                stage: "invite_unlink",
              });
            }
          }

          try {
            await executor.delete(humans).where(eq(humans.id, humanId));
          } catch (rollbackError) {
            logger.error("registry.invite_redeem_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
              stage: "human_delete",
            });
          }
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyRedeemMutation(tx as unknown as typeof db, {
          rollbackOnFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyRedeemMutation(db, {
        rollbackOnFailure: true,
      });
    }

    return c.json(
      {
        human: {
          id: humanId,
          did: humanDid,
          displayName: parsedPayload.displayName,
          role: "user",
          status: "active",
        },
        apiKey: {
          id: apiKeyId,
          name: parsedPayload.apiKeyName,
          token: apiKeyToken,
        },
      },
      201,
    );
  });

  app.post(ME_API_KEYS_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown = {};
    try {
      const rawBody = await c.req.text();
      if (rawBody.trim().length > 0) {
        payload = JSON.parse(rawBody);
      }
    } catch {
      throw new AppError({
        code: "API_KEY_CREATE_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseApiKeyCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const human = c.get("human");
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(Date.now() + 1);
    const createdAt = nowIso();

    const db = createDb(c.env.DB);
    await db.insert(api_keys).values({
      id: apiKeyId,
      human_id: human.id,
      key_hash: apiKeyHash,
      key_prefix: apiKeyPrefix,
      name: parsedPayload.name,
      status: "active",
      created_at: createdAt,
      last_used_at: null,
    });

    return c.json(
      {
        apiKey: {
          id: apiKeyId,
          name: parsedPayload.name,
          status: "active",
          createdAt,
          lastUsedAt: null,
          token: apiKeyToken,
        },
      },
      201,
    );
  });

  app.get(ME_API_KEYS_PATH, createApiKeyAuth(), async (c) => {
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: api_keys.id,
        name: api_keys.name,
        status: api_keys.status,
        created_at: api_keys.created_at,
        last_used_at: api_keys.last_used_at,
      })
      .from(api_keys)
      .where(eq(api_keys.human_id, human.id))
      .orderBy(desc(api_keys.created_at), desc(api_keys.id));

    return c.json({
      apiKeys: rows.map(mapApiKeyMetadataRow),
    });
  });

  app.delete(`${ME_API_KEYS_PATH}/:id`, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const apiKeyId = parseApiKeyRevokePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: api_keys.id,
        status: api_keys.status,
      })
      .from(api_keys)
      .where(and(eq(api_keys.id, apiKeyId), eq(api_keys.human_id, human.id)))
      .limit(1);

    const existingKey = rows[0];
    if (!existingKey) {
      throw apiKeyNotFoundError();
    }

    if (existingKey.status === "revoked") {
      return c.body(null, 204);
    }

    await db
      .update(api_keys)
      .set({
        status: "revoked",
      })
      .where(and(eq(api_keys.id, apiKeyId), eq(api_keys.human_id, human.id)));

    return c.body(null, 204);
  });

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
      issuer: resolveRegistryIssuer(config.ENVIRONMENT),
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

      try {
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
    const nowMillis = Date.now();
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

      const updatedRows = getMutationRowCount(updateResult);
      if (updatedRows === 0) {
        throw agentAuthRefreshConflictError();
      }

      await insertAgentAuthEvent({
        db: executor,
        agentId: existingAgent.id,
        sessionId: existingSession.id,
        eventType: "refreshed",
        createdAt: refreshedAt,
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

    const nowMillis = Date.now();
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

    const updatedRows = getMutationRowCount(updateResult);
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
          id: generateUlid(Date.now()),
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
          createdAt: revokedAt,
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
      issuer: resolveRegistryIssuer(config.ENVIRONMENT),
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
          id: generateUlid(Date.now()),
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

  return app;
}

const app = createRegistryApp();

export { createRegistryApp };
export default app;
