import { AppError, type Logger } from "@clawdentity/sdk";
import { createMiddleware } from "hono/factory";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import type { ProxyConfig } from "./config.js";

type InMemoryBucket = {
  windowStartedAtMs: number;
  count: number;
};

export type AgentRateLimitMiddlewareOptions = {
  config: Pick<
    ProxyConfig,
    "agentRateLimitRequestsPerMinute" | "agentRateLimitWindowMs"
  >;
  logger: Logger;
  nowMs?: () => number;
};

export function createAgentRateLimitMiddleware(
  options: AgentRateLimitMiddlewareOptions,
) {
  const nowMs = options.nowMs ?? Date.now;
  const buckets = new Map<string, InMemoryBucket>();

  return createMiddleware<{ Variables: ProxyRequestVariables }>(
    async (c, next) => {
      if (c.req.path === "/health") {
        await next();
        return;
      }

      const auth = c.get("auth");
      if (!auth) {
        await next();
        return;
      }

      const now = nowMs();
      for (const [agentDid, bucket] of buckets.entries()) {
        if (
          now - bucket.windowStartedAtMs >=
          options.config.agentRateLimitWindowMs
        ) {
          buckets.delete(agentDid);
        }
      }

      const existing = buckets.get(auth.agentDid);
      if (
        !existing ||
        now - existing.windowStartedAtMs >=
          options.config.agentRateLimitWindowMs
      ) {
        buckets.set(auth.agentDid, {
          windowStartedAtMs: now,
          count: 1,
        });
        await next();
        return;
      }

      if (existing.count >= options.config.agentRateLimitRequestsPerMinute) {
        options.logger.warn("proxy.rate_limit.exceeded", {
          agentDid: auth.agentDid,
          windowMs: options.config.agentRateLimitWindowMs,
          maxRequests: options.config.agentRateLimitRequestsPerMinute,
        });
        throw new AppError({
          code: "PROXY_RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
          status: 429,
          expose: true,
        });
      }

      existing.count += 1;
      buckets.set(auth.agentDid, existing);
      await next();
    },
  );
}
