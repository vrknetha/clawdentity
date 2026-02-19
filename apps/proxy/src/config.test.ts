import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
  DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
  DEFAULT_INJECT_IDENTITY_INTO_MESSAGE,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_PROXY_ENVIRONMENT,
  DEFAULT_PROXY_LISTEN_PORT,
  DEFAULT_REGISTRY_URL,
  DEFAULT_RELAY_QUEUE_MAX_MESSAGES_PER_AGENT,
  DEFAULT_RELAY_QUEUE_TTL_SECONDS,
  DEFAULT_RELAY_RETRY_INITIAL_MS,
  DEFAULT_RELAY_RETRY_JITTER_RATIO,
  DEFAULT_RELAY_RETRY_MAX_ATTEMPTS,
  DEFAULT_RELAY_RETRY_MAX_MS,
  loadProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";

describe("proxy config", () => {
  it("parses defaults without requiring OpenClaw vars", () => {
    const config = parseProxyConfig({});

    expect(config).toEqual({
      listenPort: DEFAULT_PROXY_LISTEN_PORT,
      openclawBaseUrl: DEFAULT_OPENCLAW_BASE_URL,
      registryUrl: DEFAULT_REGISTRY_URL,
      environment: DEFAULT_PROXY_ENVIRONMENT,
      crlRefreshIntervalMs: DEFAULT_CRL_REFRESH_INTERVAL_MS,
      crlMaxAgeMs: DEFAULT_CRL_MAX_AGE_MS,
      crlStaleBehavior: "fail-open",
      agentRateLimitRequestsPerMinute:
        DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
      agentRateLimitWindowMs: DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS,
      injectIdentityIntoMessage: DEFAULT_INJECT_IDENTITY_INTO_MESSAGE,
      relayQueueMaxMessagesPerAgent: DEFAULT_RELAY_QUEUE_MAX_MESSAGES_PER_AGENT,
      relayQueueTtlSeconds: DEFAULT_RELAY_QUEUE_TTL_SECONDS,
      relayRetryInitialMs: DEFAULT_RELAY_RETRY_INITIAL_MS,
      relayRetryMaxMs: DEFAULT_RELAY_RETRY_MAX_MS,
      relayRetryMaxAttempts: DEFAULT_RELAY_RETRY_MAX_ATTEMPTS,
      relayRetryJitterRatio: DEFAULT_RELAY_RETRY_JITTER_RATIO,
    });
  });

  it("supports canonical proxy env inputs", () => {
    const config = parseProxyConfig({
      PORT: "4100",
      CLAWDENTITY_REGISTRY_URL: "https://registry.example.com",
      REGISTRY_INTERNAL_SERVICE_ID: "01KHSVCABCDEFGHJKMNOPQRST",
      REGISTRY_INTERNAL_SERVICE_SECRET:
        "clw_srv_kx2qkQhJ9j9d2l2fF6uH3m6l9Hj7sVfW8Q2r3L4",
      ENVIRONMENT: "local",
      CRL_STALE_BEHAVIOR: "fail-closed",
      AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE: "75",
      AGENT_RATE_LIMIT_WINDOW_MS: "90000",
      INJECT_IDENTITY_INTO_MESSAGE: "true",
      RELAY_QUEUE_MAX_MESSAGES_PER_AGENT: "700",
      RELAY_QUEUE_TTL_SECONDS: "1800",
      RELAY_RETRY_INITIAL_MS: "2000",
      RELAY_RETRY_MAX_MS: "15000",
      RELAY_RETRY_MAX_ATTEMPTS: "7",
      RELAY_RETRY_JITTER_RATIO: "0.4",
    });

    expect(config.listenPort).toBe(4100);
    expect(config.registryUrl).toBe("https://registry.example.com");
    expect(config.registryInternalServiceId).toBe("01KHSVCABCDEFGHJKMNOPQRST");
    expect(config.registryInternalServiceSecret).toBe(
      "clw_srv_kx2qkQhJ9j9d2l2fF6uH3m6l9Hj7sVfW8Q2r3L4",
    );
    expect(config.environment).toBe("local");
    expect(config.crlStaleBehavior).toBe("fail-closed");
    expect(config.agentRateLimitRequestsPerMinute).toBe(75);
    expect(config.agentRateLimitWindowMs).toBe(90000);
    expect(config.injectIdentityIntoMessage).toBe(true);
    expect(config.relayQueueMaxMessagesPerAgent).toBe(700);
    expect(config.relayQueueTtlSeconds).toBe(1800);
    expect(config.relayRetryInitialMs).toBe(2000);
    expect(config.relayRetryMaxMs).toBe(15000);
    expect(config.relayRetryMaxAttempts).toBe(7);
    expect(config.relayRetryJitterRatio).toBe(0.4);
  });

  it("allows disabling identity injection via env override", () => {
    const config = parseProxyConfig({
      INJECT_IDENTITY_INTO_MESSAGE: "false",
    });

    expect(config.injectIdentityIntoMessage).toBe(false);
  });

  it("throws when deprecated ALLOW_ALL_VERIFIED is set", () => {
    expect(() =>
      parseProxyConfig({
        ALLOW_ALL_VERIFIED: "true",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws on unsupported environment value", () => {
    expect(() =>
      parseProxyConfig({
        ENVIRONMENT: "staging",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws on invalid agent DID rate-limit values", () => {
    expect(() =>
      parseProxyConfig({
        AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE: "0",
      }),
    ).toThrow(ProxyConfigError);
    expect(() =>
      parseProxyConfig({
        AGENT_RATE_LIMIT_WINDOW_MS: "-1",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws on invalid injectIdentityIntoMessage value", () => {
    expect(() =>
      parseProxyConfig({
        INJECT_IDENTITY_INTO_MESSAGE: "maybe",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws on invalid relay queue/retry values", () => {
    expect(() =>
      parseProxyConfig({
        RELAY_QUEUE_MAX_MESSAGES_PER_AGENT: "0",
      }),
    ).toThrow(ProxyConfigError);
    expect(() =>
      parseProxyConfig({
        RELAY_RETRY_INITIAL_MS: "2000",
        RELAY_RETRY_MAX_MS: "1000",
      }),
    ).toThrow(ProxyConfigError);
    expect(() =>
      parseProxyConfig({
        RELAY_RETRY_JITTER_RATIO: "1.1",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws when only one internal service credential is provided", () => {
    expect(() =>
      parseProxyConfig({
        REGISTRY_INTERNAL_SERVICE_ID: "svc-id-only",
      }),
    ).toThrow(ProxyConfigError);
    expect(() =>
      parseProxyConfig({
        REGISTRY_INTERNAL_SERVICE_SECRET: "clw_srv_secret-only",
      }),
    ).toThrow(ProxyConfigError);
  });
});

describe("proxy config loading", () => {
  function createSandbox() {
    const root = mkdtempSync(join(tmpdir(), "clawdentity-proxy-config-"));
    const cwd = join(root, "workspace");
    const stateDir = join(root, ".openclaw");
    const clawdentityDir = join(root, ".clawdentity");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(clawdentityDir, { recursive: true });

    const cleanup = () => {
      rmSync(root, { recursive: true, force: true });
    };

    return { root, cwd, stateDir, clawdentityDir, cleanup };
  }

  it("loads cwd .env first, then state .env without overriding existing values", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.cwd, ".env"),
        [
          "OPENCLAW_BASE_URL=https://cwd.example.com",
          "REGISTRY_URL=https://registry.cwd.example.com",
        ].join("\n"),
      );
      writeFileSync(
        join(sandbox.stateDir, ".env"),
        [
          "REGISTRY_URL=https://registry.state.example.com",
          "LISTEN_PORT=4444",
        ].join("\n"),
      );

      const config = loadProxyConfig(
        {
          OPENCLAW_BASE_URL: "https://env.example.com",
        },
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawBaseUrl).toBe("https://env.example.com");
      expect(config.listenPort).toBe(4444);
      expect(config.registryUrl).toBe("https://registry.cwd.example.com");
    } finally {
      sandbox.cleanup();
    }
  });

  it("loads config when optional OpenClaw vars are absent", () => {
    const sandbox = createSandbox();
    try {
      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawBaseUrl).toBe(DEFAULT_OPENCLAW_BASE_URL);
      expect(config.registryUrl).toBe(DEFAULT_REGISTRY_URL);
    } finally {
      sandbox.cleanup();
    }
  });

  it("loads INJECT_IDENTITY_INTO_MESSAGE from .env", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.cwd, ".env"),
        "INJECT_IDENTITY_INTO_MESSAGE=true",
      );

      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.injectIdentityIntoMessage).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("treats empty env variables as missing and accepts dotenv fallback", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.cwd, ".env"),
        "REGISTRY_URL=https://registry.cwd.example.com",
      );

      const config = loadProxyConfig(
        {
          REGISTRY_URL: "",
        },
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.registryUrl).toBe("https://registry.cwd.example.com");
    } finally {
      sandbox.cleanup();
    }
  });

  it("falls back to ~/.clawdentity/openclaw-relay.json when OPENCLAW_BASE_URL is missing", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.clawdentityDir, "openclaw-relay.json"),
        JSON.stringify(
          {
            openclawBaseUrl: "http://127.0.0.1:19111",
            updatedAt: "2026-02-15T20:00:00.000Z",
          },
          null,
          2,
        ),
      );

      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawBaseUrl).toBe("http://127.0.0.1:19111");
    } finally {
      sandbox.cleanup();
    }
  });

  it("prefers env OPENCLAW_BASE_URL over ~/.clawdentity/openclaw-relay.json", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.clawdentityDir, "openclaw-relay.json"),
        JSON.stringify(
          {
            openclawBaseUrl: "http://127.0.0.1:19111",
            updatedAt: "2026-02-15T20:00:00.000Z",
          },
          null,
          2,
        ),
      );

      const config = loadProxyConfig(
        {
          OPENCLAW_BASE_URL: "http://127.0.0.1:19999",
        },
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawBaseUrl).toBe("http://127.0.0.1:19999");
    } finally {
      sandbox.cleanup();
    }
  });

  it("throws when openclaw-relay.json is invalid and base-url fallback is required", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.clawdentityDir, "openclaw-relay.json"),
        "{bad-json",
      );

      expect(() =>
        loadProxyConfig(
          {},
          {
            cwd: sandbox.cwd,
            homeDir: sandbox.root,
          },
        ),
      ).toThrow(ProxyConfigError);
    } finally {
      sandbox.cleanup();
    }
  });
});
