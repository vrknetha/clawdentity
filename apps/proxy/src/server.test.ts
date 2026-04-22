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
      config: parseProxyConfig({}),
    });

    const res = await app.request("/health");
    const body = (await res.json()) as {
      status: string;
      ready: boolean;
      version: string;
      environment: string;
      readiness: {
        versionSource: string;
        relaySessionNamespaceConfigured: boolean;
      };
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      version: PROXY_VERSION,
      environment: DEFAULT_PROXY_ENVIRONMENT,
      ready: false,
      readiness: {
        versionSource: "default",
        relaySessionNamespaceConfigured: false,
      },
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("uses ENVIRONMENT from config for health payload", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({
        ENVIRONMENT: "local",
      }),
    });

    const res = await app.request("/health");
    const body = (await res.json()) as { environment: string };

    expect(res.status).toBe(200);
    expect(body.environment).toBe("local");
  });

  it("uses provided app version when supplied by runtime", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({}),
      version: "sha-123456",
      versionSource: "APP_VERSION",
    });

    const res = await app.request("/health");
    const body = (await res.json()) as {
      version: string;
      readiness: { versionSource: string };
    };

    expect(res.status).toBe(200);
    expect(body.version).toBe("sha-123456");
    expect(body.readiness.versionSource).toBe("APP_VERSION");
  });

  it("emits structured request completion log for /health", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const app = createProxyApp({
        config: parseProxyConfig({}),
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

  it("suppresses successful request logs in production", async () => {
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const app = createProxyApp({
        config: parseProxyConfig({
          ENVIRONMENT: "production",
          BOOTSTRAP_INTERNAL_SERVICE_ID: "svc",
          BOOTSTRAP_INTERNAL_SERVICE_SECRET: "secret",
        }),
      });

      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits warn completion logs for handled production errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const app = createProxyApp({
        config: parseProxyConfig({
          ENVIRONMENT: "production",
          BOOTSTRAP_INTERNAL_SERVICE_ID: "svc",
          BOOTSTRAP_INTERNAL_SERVICE_SECRET: "secret",
        }),
      });

      const res = await app.request(RELAY_CONNECT_PATH, {
        headers: {
          "CF-Connecting-IP": "198.51.100.91",
        },
      });

      expect(res.status).toBe(401);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();

      const line = String(warnSpy.mock.calls.at(-1)?.[0] ?? "");
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.message).toBe("request.completed");
      expect(parsed.status).toBe(401);
      expect(parsed.path).toBe(RELAY_CONNECT_PATH);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("fails startup when config is invalid", () => {
    expect(() =>
      startProxyServer({
        env: {
          DELIVERY_WEBHOOK_BASE_URL: "bad-url",
        },
      }),
    ).toThrow(ProxyConfigError);
  });

  it("fails node runtime startup for non-local environments", () => {
    expect(() =>
      startProxyServer({
        config: parseProxyConfig({
          ENVIRONMENT: "development",
        }),
      }),
    ).toThrow(ProxyConfigError);

    expect(() =>
      startProxyServer({
        config: parseProxyConfig({
          ENVIRONMENT: "production",
        }),
      }),
    ).toThrow(ProxyConfigError);
  });

  it("returns 429 for repeated unauthenticated probes on /hooks/message from same IP", async () => {
    const app = createProxyApp({
      config: parseProxyConfig({}),
      rateLimit: {
        publicIpMaxRequests: 2,
        publicIpWindowMs: 60_000,
      },
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request("/hooks/message", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "198.51.100.41",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
    }

    const rateLimited = await app.request("/hooks/message", {
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
      config: parseProxyConfig({}),
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
