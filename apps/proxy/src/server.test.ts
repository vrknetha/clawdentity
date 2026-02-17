import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROXY_ENVIRONMENT,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";
import { PROXY_VERSION } from "./index.js";
import { startProxyServer } from "./node-server.js";
import { createProxyApp } from "./server.js";

describe("proxy server", () => {
  it("returns health response with status, version, and environment", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
      }),
    });

    const res = await app.request("/health");
    const body = (await res.json()) as {
      status: string;
      version: string;
      environment: string;
    };

    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      version: PROXY_VERSION,
      environment: DEFAULT_PROXY_ENVIRONMENT,
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("uses ENVIRONMENT from config for health payload", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
        ENVIRONMENT: "local",
      }),
    });

    const res = await app.request("/health");
    const body = (await res.json()) as { environment: string };

    expect(res.status).toBe(200);
    expect(body.environment).toBe("local");
  });

  it("emits structured request completion log for /health", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const app = createProxyApp({
        config: parseProxyConfig({
          OPENCLAW_HOOK_TOKEN: "token",
        }),
      });

      const res = await app.request("/health");
      expect(res.status).toBe(200);

      const line = String(logSpy.mock.calls.at(-1)?.[0] ?? "");
      const parsed = JSON.parse(line) as Record<string, unknown>;

      expect(parsed.message).toBe("request.completed");
      expect(parsed.service).toBe("proxy");
      expect(parsed.path).toBe("/health");
      expect(parsed.status).toBe(200);
      expect(typeof parsed.requestId).toBe("string");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails startup when config is invalid", () => {
    expect(() =>
      startProxyServer({
        env: {
          OPENCLAW_BASE_URL: "bad-url",
        },
      }),
    ).toThrow(ProxyConfigError);
  });

  it("returns 429 for repeated unauthenticated probes on /hooks/agent from same IP", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
      }),
      rateLimit: {
        publicIpMaxRequests: 2,
        publicIpWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request("/hooks/agent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "198.51.100.41",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    }

    const rateLimited = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.41",
      },
      body: JSON.stringify({}),
    });

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PUBLIC_RATE_LIMIT_EXCEEDED");
  });

  it("returns 429 for repeated unauthenticated probes on relay connect from same IP", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
      }),
      rateLimit: {
        publicIpMaxRequests: 2,
        publicIpWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request(RELAY_CONNECT_PATH, {
        headers: {
          "CF-Connecting-IP": "198.51.100.42",
        },
      });
      expect(response.status).toBe(401);
    }

    const rateLimited = await app.request(RELAY_CONNECT_PATH, {
      headers: {
        "CF-Connecting-IP": "198.51.100.42",
      },
    });

    expect(rateLimited.status).toBe(429);
    const body = (await rateLimited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PUBLIC_RATE_LIMIT_EXCEEDED");
  });
});
