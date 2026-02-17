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
});
