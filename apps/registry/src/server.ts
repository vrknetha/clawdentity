import {
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  parseRegistryConfig,
  type RegistryConfig,
} from "@clawdentity/sdk";
import { Hono } from "hono";
import {
  type AuthenticatedHuman,
  createApiKeyAuth,
} from "./auth/apiKeyAuth.js";

type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
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

  return app;
}

const app = createRegistryApp();

export { createRegistryApp };
export default app;
