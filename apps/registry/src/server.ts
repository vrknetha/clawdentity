import { generateUlid } from "@clawdentity/protocol";
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
} from "@clawdentity/sdk";
import { and, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { mapAgentListRow, parseAgentListQuery } from "./agent-list.js";
import {
  buildAgentRegistration,
  buildAgentReissue,
  resolveRegistryIssuer,
} from "./agent-registration.js";
import {
  agentNotFoundError,
  invalidAgentReissueStateError,
  invalidAgentRevokeStateError,
  parseAgentRevokePath,
} from "./agent-revocation.js";
import {
  type AuthenticatedHuman,
  createApiKeyAuth,
} from "./auth/api-key-auth.js";
import { createDb } from "./db/client.js";
import { agents, revocations } from "./db/schema.js";
import { resolveRegistrySigner } from "./registry-signer.js";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  APP_VERSION?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_KEYS?: string;
};
const logger = createLogger({ service: "registry" });
const REGISTRY_KEY_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=60";

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

function createRegistryApp() {
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

  app.get("/v1/me", createApiKeyAuth(), (c) => {
    return c.json({ human: c.get("human") });
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
    const registration = buildAgentRegistration({
      payload,
      ownerDid: human.did,
      issuer: resolveRegistryIssuer(config.ENVIRONMENT),
      environment: config.ENVIRONMENT,
    });
    const signer = await resolveRegistrySigner(config);
    const ait = await signAIT({
      claims: registration.claims,
      signerKid: signer.signerKid,
      signerKeypair: signer.signerKeypair,
    });

    const db = createDb(c.env.DB);
    await db.insert(agents).values({
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

    return c.json({ agent: registration.agent, ait }, 201);
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
