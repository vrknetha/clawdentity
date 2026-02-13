import { AppError } from "@clawdentity/sdk";
import type { MiddlewareHandler } from "hono";

export const RESOLVE_RATE_LIMIT_WINDOW_MS = 60_000;
export const RESOLVE_RATE_LIMIT_MAX_REQUESTS = 10;
export const RESOLVE_RATE_LIMIT_MAX_BUCKETS = 10_000;

type InMemoryBucket = {
  windowStartedAtMs: number;
  count: number;
};

type RateLimitOptions = {
  bucketKey: string;
  maxRequests: number;
  maxBuckets?: number;
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

export function createInMemoryRateLimit(
  options: RateLimitOptions,
): MiddlewareHandler {
  const nowMs = options.nowMs ?? Date.now;
  const maxBuckets = options.maxBuckets ?? RESOLVE_RATE_LIMIT_MAX_BUCKETS;
  const buckets = new Map<string, InMemoryBucket>();

  return async (c, next) => {
    const now = nowMs();
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.windowStartedAtMs >= options.windowMs) {
        buckets.delete(key);
      }
    }

    const clientIp = resolveClientIp(c.req.raw);
    const key = `${options.bucketKey}:${clientIp}`;
    const existing = buckets.get(key);

    if (!existing || now - existing.windowStartedAtMs >= options.windowMs) {
      if (!existing && buckets.size >= maxBuckets) {
        let oldestKey: string | undefined;
        let oldestWindowStart = Number.POSITIVE_INFINITY;

        for (const [bucketKey, bucket] of buckets.entries()) {
          if (bucket.windowStartedAtMs < oldestWindowStart) {
            oldestWindowStart = bucket.windowStartedAtMs;
            oldestKey = bucketKey;
          }
        }

        if (oldestKey) {
          buckets.delete(oldestKey);
        }
      }

      buckets.set(key, {
        windowStartedAtMs: now,
        count: 1,
      });
      await next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      throw new AppError({
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        status: 429,
        expose: true,
      });
    }

    existing.count += 1;
    buckets.set(key, existing);
    await next();
  };
}
