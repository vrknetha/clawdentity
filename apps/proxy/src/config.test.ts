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
  loadProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";

const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

describe("proxy config", () => {
  it("parses defaults without requiring OpenClaw token", () => {
    const config = parseProxyConfig({});

    expect(config).toEqual({
      listenPort: DEFAULT_PROXY_LISTEN_PORT,
      openclawBaseUrl: DEFAULT_OPENCLAW_BASE_URL,
      openclawHookToken: undefined,
      registryUrl: DEFAULT_REGISTRY_URL,
      environment: DEFAULT_PROXY_ENVIRONMENT,
      crlRefreshIntervalMs: DEFAULT_CRL_REFRESH_INTERVAL_MS,
      crlMaxAgeMs: DEFAULT_CRL_MAX_AGE_MS,
      crlStaleBehavior: "fail-open",
      agentRateLimitRequestsPerMinute:
        DEFAULT_AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE,
      agentRateLimitWindowMs: DEFAULT_AGENT_RATE_LIMIT_WINDOW_MS,
      injectIdentityIntoMessage: DEFAULT_INJECT_IDENTITY_INTO_MESSAGE,
    });
  });

  it("supports canonical proxy env inputs", () => {
    const config = parseProxyConfig({
      PORT: "4100",
      OPENCLAW_HOOK_TOKEN: "hooks-token",
      CLAWDENTITY_REGISTRY_URL: "https://registry.example.com",
      ENVIRONMENT: "local",
      CRL_STALE_BEHAVIOR: "fail-closed",
      AGENT_RATE_LIMIT_REQUESTS_PER_MINUTE: "75",
      AGENT_RATE_LIMIT_WINDOW_MS: "90000",
      INJECT_IDENTITY_INTO_MESSAGE: "true",
    });

    expect(config.listenPort).toBe(4100);
    expect(config.openclawHookToken).toBe("hooks-token");
    expect(config.registryUrl).toBe("https://registry.example.com");
    expect(config.environment).toBe("local");
    expect(config.crlStaleBehavior).toBe("fail-closed");
    expect(config.agentRateLimitRequestsPerMinute).toBe(75);
    expect(config.agentRateLimitWindowMs).toBe(90000);
    expect(config.injectIdentityIntoMessage).toBe(true);
  });

  it("allows disabling identity injection via env override", () => {
    const config = parseProxyConfig({
      INJECT_IDENTITY_INTO_MESSAGE: "false",
    });

    expect(config.injectIdentityIntoMessage).toBe(false);
  });

  it("accepts missing hook token for relay-only startup", () => {
    expect(() => parseProxyConfig({})).not.toThrow();
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
          "OPENCLAW_HOOK_TOKEN=from-cwd-dotenv",
        ].join("\n"),
      );
      writeFileSync(
        join(sandbox.stateDir, ".env"),
        ["OPENCLAW_HOOK_TOKEN=from-state-dotenv", "LISTEN_PORT=4444"].join(
          "\n",
        ),
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
      expect(config.openclawHookToken).toBe("from-cwd-dotenv");
      expect(config.listenPort).toBe(4444);
      expect(config.registryUrl).toBe("https://registry.cwd.example.com");
    } finally {
      sandbox.cleanup();
    }
  });

  it("allows loading config when no OpenClaw token fallback is present", () => {
    const sandbox = createSandbox();
    try {
      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawHookToken).toBeUndefined();
      expect(config.openclawBaseUrl).toBe(DEFAULT_OPENCLAW_BASE_URL);
    } finally {
      sandbox.cleanup();
    }
  });

  it("loads INJECT_IDENTITY_INTO_MESSAGE from .env", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.cwd, ".env"),
        [
          "OPENCLAW_HOOK_TOKEN=from-cwd-dotenv",
          "INJECT_IDENTITY_INTO_MESSAGE=true",
        ].join("\n"),
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
        "OPENCLAW_HOOK_TOKEN=from-cwd-dotenv",
      );

      const config = loadProxyConfig(
        {
          OPENCLAW_HOOK_TOKEN: "",
        },
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawHookToken).toBe("from-cwd-dotenv");
    } finally {
      sandbox.cleanup();
    }
  });

  it("falls back to hooks.token from openclaw.json (JSON5) when env token is missing", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.stateDir, OPENCLAW_CONFIG_FILENAME),
        [
          "{",
          "  // JSON5 comment",
          "  hooks: {",
          '    token: "token-from-openclaw-config",',
          "  },",
          "}",
        ].join("\n"),
      );

      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawHookToken).toBe("token-from-openclaw-config");
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
        {
          OPENCLAW_HOOK_TOKEN: "token",
        },
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
          OPENCLAW_HOOK_TOKEN: "token",
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

  it("uses legacy state directory when canonical .openclaw does not exist", () => {
    const sandbox = createSandbox();
    try {
      rmSync(sandbox.stateDir, { recursive: true, force: true });
      const legacyStateDir = join(sandbox.root, ".clawdbot");
      mkdirSync(legacyStateDir, { recursive: true });
      writeFileSync(
        join(legacyStateDir, ".env"),
        "OPENCLAW_HOOK_TOKEN=legacy-token",
      );

      const config = loadProxyConfig(
        {},
        {
          cwd: sandbox.cwd,
          homeDir: sandbox.root,
        },
      );

      expect(config.openclawHookToken).toBe("legacy-token");
    } finally {
      sandbox.cleanup();
    }
  });

  it("throws when openclaw.json is invalid and token fallback is required", () => {
    const sandbox = createSandbox();
    try {
      writeFileSync(
        join(sandbox.stateDir, OPENCLAW_CONFIG_FILENAME),
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
