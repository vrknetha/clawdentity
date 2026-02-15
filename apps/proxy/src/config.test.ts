import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_PROXY_LISTEN_PORT,
  DEFAULT_REGISTRY_URL,
  loadProxyConfig,
  ProxyConfigError,
  parseProxyConfig,
} from "./config.js";

const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

describe("proxy config", () => {
  it("parses required settings and applies defaults", () => {
    const config = parseProxyConfig({
      OPENCLAW_HOOK_TOKEN: "super-secret-hook-token",
    });

    expect(config).toEqual({
      listenPort: DEFAULT_PROXY_LISTEN_PORT,
      openclawBaseUrl: DEFAULT_OPENCLAW_BASE_URL,
      openclawHookToken: "super-secret-hook-token",
      registryUrl: DEFAULT_REGISTRY_URL,
      allowList: {
        owners: [],
        agents: [],
        allowAllVerified: false,
      },
      crlRefreshIntervalMs: DEFAULT_CRL_REFRESH_INTERVAL_MS,
      crlMaxAgeMs: DEFAULT_CRL_MAX_AGE_MS,
      crlStaleBehavior: "fail-open",
    });
  });

  it("supports OpenClaw-compatible env aliases", () => {
    const config = parseProxyConfig({
      PORT: "4100",
      OPENCLAW_HOOKS_TOKEN: "hooks-token",
      CLAWDENTITY_REGISTRY_URL: "https://registry.example.com",
      CRL_STALE_BEHAVIOR: "fail-closed",
    });

    expect(config.listenPort).toBe(4100);
    expect(config.openclawHookToken).toBe("hooks-token");
    expect(config.registryUrl).toBe("https://registry.example.com");
    expect(config.crlStaleBehavior).toBe("fail-closed");
  });

  it("parses allow list object and override env flags", () => {
    const config = parseProxyConfig({
      OPENCLAW_HOOK_TOKEN: "token",
      ALLOW_LIST: JSON.stringify({
        owners: ["did:claw:owner:1"],
        agents: ["did:claw:agent:1"],
        allowAllVerified: false,
      }),
      ALLOWLIST_OWNERS: "did:claw:owner:2,did:claw:owner:3",
      ALLOW_ALL_VERIFIED: "true",
    });

    expect(config.allowList).toEqual({
      owners: ["did:claw:owner:2", "did:claw:owner:3"],
      agents: ["did:claw:agent:1"],
      allowAllVerified: true,
    });
  });

  it("throws on missing hook token", () => {
    expect(() => parseProxyConfig({})).toThrow(ProxyConfigError);
  });

  it("throws on malformed allow list JSON", () => {
    expect(() =>
      parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
        ALLOW_LIST: "{not-json",
      }),
    ).toThrow(ProxyConfigError);
  });

  it("throws on invalid boolean override", () => {
    expect(() =>
      parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "token",
        ALLOW_ALL_VERIFIED: "maybe",
      }),
    ).toThrow(ProxyConfigError);
  });
});

describe("proxy config loading", () => {
  function createSandbox() {
    const root = mkdtempSync(join(tmpdir(), "clawdentity-proxy-config-"));
    const cwd = join(root, "workspace");
    const stateDir = join(root, ".openclaw");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const cleanup = () => {
      rmSync(root, { recursive: true, force: true });
    };

    return { root, cwd, stateDir, cleanup };
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
