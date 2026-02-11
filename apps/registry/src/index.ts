import {
  createHonoErrorHandler,
  createLogger,
  createRequestContextMiddleware,
  createRequestLoggingMiddleware,
  parseRegistryConfig,
  type RegistryConfig,
} from "@clawdentity/sdk";
import { Hono } from "hono";

type Bindings = { DB: D1Database; ENVIRONMENT: string };
const logger = createLogger({ service: "registry" });
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
  Variables: { requestId: string };
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

export default app;
