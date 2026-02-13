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

type Bindings = { DB: D1Database; ENVIRONMENT: string };
const logger = createLogger({ service: "registry" });

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

  app.get("/v1/me", createApiKeyAuth(), (c) => {
    return c.json({ human: c.get("human") });
  });

  return app;
}

const app = createRegistryApp();

export { createRegistryApp };
export default app;
