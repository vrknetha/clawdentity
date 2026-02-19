import {
  createHonoErrorHandler,
  createRequestContextMiddleware,
  type Logger,
} from "@clawdentity/sdk";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAgentRateLimitMiddleware } from "./agent-rate-limit-middleware.js";
import type { ProxyRequestVariables } from "./auth-middleware.js";

type MockLogger = Logger & {
  warnSpy: ReturnType<typeof vi.fn>;
};

function createMockLogger(): MockLogger {
  const warnSpy = vi.fn();
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => logger,
    warnSpy,
  };
  return logger;
}

function createRateLimitTestApp(input: {
  maxRequests: number;
  windowMs: number;
  nowMs: () => number;
  logger: Logger;
}) {
  const app = new Hono<{ Variables: ProxyRequestVariables }>();
  app.use("*", createRequestContextMiddleware());
  app.use("*", async (c, next) => {
    const testAgentDid = c.req.header("x-test-agent-did");
    if (typeof testAgentDid === "string" && testAgentDid.trim().length > 0) {
      c.set("auth", {
        agentDid: testAgentDid,
        ownerDid: "did:claw:human:test-owner",
        aitJti: "test-jti",
        issuer: "https://registry.clawdentity.com",
        cnfPublicKey: "test-key",
      });
    }

    await next();
  });
  app.use(
    "*",
    createAgentRateLimitMiddleware({
      config: {
        agentRateLimitRequestsPerMinute: input.maxRequests,
        agentRateLimitWindowMs: input.windowMs,
      },
      logger: input.logger,
      nowMs: input.nowMs,
    }),
  );
  app.onError(createHonoErrorHandler(input.logger));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/protected", (c) =>
    c.json({ ok: true, agentDid: c.get("auth")?.agentDid }),
  );

  return app;
}

describe("proxy agent DID rate limit middleware", () => {
  it("returns 429 with PROXY_RATE_LIMIT_EXCEEDED when requests exceed limit", async () => {
    const now = 1_000;
    const logger = createMockLogger();
    const app = createRateLimitTestApp({
      maxRequests: 2,
      windowMs: 60_000,
      nowMs: () => now,
      logger,
    });
    const headers = {
      "content-type": "application/json",
      "x-test-agent-did": "did:claw:agent:alpha",
    };

    const first = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "1" }),
    });
    const second = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "2" }),
    });
    const third = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "3" }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    const body = (await third.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RATE_LIMIT_EXCEEDED");
    expect(logger.warnSpy).toHaveBeenCalledWith("proxy.rate_limit.exceeded", {
      agentDid: "did:claw:agent:alpha",
      windowMs: 60_000,
      maxRequests: 2,
    });
  });

  it("tracks counters per agent DID independently", async () => {
    const logger = createMockLogger();
    const app = createRateLimitTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      nowMs: () => 2_000,
      logger,
    });

    const alphaHeaders = {
      "content-type": "application/json",
      "x-test-agent-did": "did:claw:agent:alpha",
    };
    const betaHeaders = {
      "content-type": "application/json",
      "x-test-agent-did": "did:claw:agent:beta",
    };

    const alphaFirst = await app.request("/protected", {
      method: "POST",
      headers: alphaHeaders,
      body: JSON.stringify({ message: "alpha-1" }),
    });
    const betaFirst = await app.request("/protected", {
      method: "POST",
      headers: betaHeaders,
      body: JSON.stringify({ message: "beta-1" }),
    });
    const alphaSecond = await app.request("/protected", {
      method: "POST",
      headers: alphaHeaders,
      body: JSON.stringify({ message: "alpha-2" }),
    });

    expect(alphaFirst.status).toBe(200);
    expect(betaFirst.status).toBe(200);
    expect(alphaSecond.status).toBe(429);
  });

  it("resets counters after window expiry", async () => {
    let now = 10_000;
    const logger = createMockLogger();
    const app = createRateLimitTestApp({
      maxRequests: 1,
      windowMs: 1_000,
      nowMs: () => now,
      logger,
    });
    const headers = {
      "content-type": "application/json",
      "x-test-agent-did": "did:claw:agent:alpha",
    };

    const first = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "1" }),
    });
    const second = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "2" }),
    });
    now += 1_001;
    const third = await app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "3" }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(third.status).toBe(200);
  });

  it("keeps /health unthrottled", async () => {
    const logger = createMockLogger();
    const app = createRateLimitTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      nowMs: () => 10_000,
      logger,
    });

    const first = await app.request("/health");
    const second = await app.request("/health");
    const third = await app.request("/health");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
  });
});
