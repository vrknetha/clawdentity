import {
  AppError,
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  parseRegistryConfig,
  type RegistryConfig,
  shouldExposeVerboseErrors,
  signAIT,
} from "@clawdentity/sdk";
import { Hono } from "hono";
import {
  buildAgentRegistration,
  resolveRegistryIssuer,
} from "./agentRegistration.js";
import {
  type AuthenticatedHuman,
  createApiKeyAuth,
} from "./auth/apiKeyAuth.js";
import { createDb } from "./db/client.js";
import { agents } from "./db/schema.js";
import { resolveRegistrySigner } from "./registrySigner.js";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_KEYS?: string;
};
const logger = createLogger({ service: "registry" });
const REGISTRY_KEY_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=60";

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
      version: "0.0.0",
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

  return app;
}

const app = createRegistryApp();

export { createRegistryApp };
export default app;
