import { AppError, type Logger } from "@clawdentity/sdk";
import { createMiddleware } from "hono/factory";

type InMemoryBucket = {
  windowStartedAtMs: number;
  count: number;
};

export const DEFAULT_PRE_AUTH_IP_RATE_LIMIT_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_PRE_AUTH_IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export type PublicRateLimitMiddlewareOptions = {
  logger: Logger;
  paths: string[];
  maxRequests: number;
  windowMs: number;
  nowMs?: () => number;
};

function resolveClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip");
  if (typeof cfIp === "string" && cfIp.trim().length > 0) {
    return cfIp.trim();
  }

  return "unknown";
}

export function createPublicRateLimitMiddleware(
  options: PublicRateLimitMiddlewareOptions,
) {
  const nowMs = options.nowMs ?? Date.now;
  const buckets = new Map<string, InMemoryBucket>();

  return createMiddleware(async (c, next) => {
    const matchedPath = options.paths.find((path) => path === c.req.path);
    if (!matchedPath) {
      await next();
      return;
    }

    const now = nowMs();
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.windowStartedAtMs >= options.windowMs) {
        buckets.delete(key);
      }
    }

    const clientIp = resolveClientIp(c.req.raw);
    const key = `${matchedPath}:${clientIp}`;
    const existing = buckets.get(key);

    if (!existing || now - existing.windowStartedAtMs >= options.windowMs) {
      buckets.set(key, {
        windowStartedAtMs: now,
        count: 1,
      });
      await next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      options.logger.warn("proxy.public_rate_limit.exceeded", {
        path: matchedPath,
        clientIp,
        windowMs: options.windowMs,
        maxRequests: options.maxRequests,
      });
      throw new AppError({
        code: "PROXY_PUBLIC_RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        status: 429,
        expose: true,
      });
    }

    existing.count += 1;
    buckets.set(key, existing);
    await next();
  });
}
