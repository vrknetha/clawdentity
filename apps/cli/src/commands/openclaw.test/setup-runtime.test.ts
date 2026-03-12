import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenclawInviteCode,
  setupOpenclawRelay,
  setupOpenclawRelayFromInvite,
} from "../openclaw.js";
import {
  createSandbox,
  resolveCliStateDir,
  restoreEnvVar,
  seedLocalAgentCredentials,
} from "./helpers.js";

describe("openclaw setup helpers (runtime + env)", () => {
  it("stores explicit OpenClaw base URL in relay runtime config", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
        openclawBaseUrl: "http://127.0.0.1:19001",
      });

      expect(result.openclawBaseUrl).toBe("http://127.0.0.1:19001");
      const relayRuntimeConfig = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawBaseUrl: string;
      };
      expect(relayRuntimeConfig.openclawBaseUrl).toBe("http://127.0.0.1:19001");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses OPENCLAW_BASE_URL env when setup option is omitted", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousBaseUrl = process.env.OPENCLAW_BASE_URL;
    process.env.OPENCLAW_BASE_URL = "http://127.0.0.1:19555";

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.openclawBaseUrl).toBe("http://127.0.0.1:19555");
      const relayRuntimeConfig = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawBaseUrl: string;
      };
      expect(relayRuntimeConfig.openclawBaseUrl).toBe("http://127.0.0.1:19555");
    } finally {
      restoreEnvVar("OPENCLAW_BASE_URL", previousBaseUrl);
      sandbox.cleanup();
    }
  });

  it("resolves OpenClaw state/config paths from env variables", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;

    try {
      const customStateDir = join(sandbox.homeDir, ".openclaw-custom");
      const customConfigPath = join(customStateDir, "openclaw.custom.json");
      mkdirSync(customStateDir, { recursive: true });
      writeFileSync(
        customConfigPath,
        JSON.stringify({ hooks: { enabled: false, mappings: [] } }, null, 2),
        "utf8",
      );

      process.env.OPENCLAW_STATE_DIR = customStateDir;
      process.env.OPENCLAW_CONFIG_PATH = customConfigPath;

      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.openclawConfigPath).toBe(customConfigPath);
      expect(result.transformTargetPath).toBe(
        join(customStateDir, "hooks", "transforms", "relay-to-peer.mjs"),
      );
    } finally {
      restoreEnvVar("OPENCLAW_STATE_DIR", previousStateDir);
      restoreEnvVar("OPENCLAW_CONFIG_PATH", previousConfigPath);
      sandbox.cleanup();
    }
  });

  it("resolves OpenClaw state/config paths from legacy CLAWDBOT_* env aliases", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
    const previousConfigPath = process.env.CLAWDBOT_CONFIG_PATH;
    const previousOpenclawStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousOpenclawConfigPath = process.env.OPENCLAW_CONFIG_PATH;

    try {
      const customStateDir = join(sandbox.homeDir, ".clawdbot-custom");
      const customConfigPath = join(customStateDir, "clawdbot.custom.json");
      mkdirSync(customStateDir, { recursive: true });
      writeFileSync(
        customConfigPath,
        JSON.stringify({ hooks: { enabled: false, mappings: [] } }, null, 2),
        "utf8",
      );

      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;
      process.env.CLAWDBOT_STATE_DIR = customStateDir;
      process.env.CLAWDBOT_CONFIG_PATH = customConfigPath;

      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.openclawConfigPath).toBe(customConfigPath);
      expect(result.transformTargetPath).toBe(
        join(customStateDir, "hooks", "transforms", "relay-to-peer.mjs"),
      );
    } finally {
      restoreEnvVar("CLAWDBOT_STATE_DIR", previousStateDir);
      restoreEnvVar("CLAWDBOT_CONFIG_PATH", previousConfigPath);
      restoreEnvVar("OPENCLAW_STATE_DIR", previousOpenclawStateDir);
      restoreEnvVar("OPENCLAW_CONFIG_PATH", previousOpenclawConfigPath);
      sandbox.cleanup();
    }
  });

  it("resolves default OpenClaw state from OPENCLAW_HOME", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousOpenclawHome = process.env.OPENCLAW_HOME;
    const previousOpenclawStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousOpenclawConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousClawdbotStateDir = process.env.CLAWDBOT_STATE_DIR;
    const previousClawdbotConfigPath = process.env.CLAWDBOT_CONFIG_PATH;

    try {
      const customHome = join(sandbox.homeDir, "openclaw-home");
      const customStateDir = join(customHome, ".openclaw");
      const customConfigPath = join(customStateDir, "openclaw.json");
      mkdirSync(customStateDir, { recursive: true });
      writeFileSync(
        customConfigPath,
        JSON.stringify({ hooks: { enabled: false, mappings: [] } }, null, 2),
        "utf8",
      );

      process.env.OPENCLAW_HOME = customHome;
      delete process.env.OPENCLAW_STATE_DIR;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.CLAWDBOT_STATE_DIR;
      delete process.env.CLAWDBOT_CONFIG_PATH;

      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.openclawConfigPath).toBe(customConfigPath);
      expect(result.transformTargetPath).toBe(
        join(customStateDir, "hooks", "transforms", "relay-to-peer.mjs"),
      );
    } finally {
      restoreEnvVar("OPENCLAW_HOME", previousOpenclawHome);
      restoreEnvVar("OPENCLAW_STATE_DIR", previousOpenclawStateDir);
      restoreEnvVar("OPENCLAW_CONFIG_PATH", previousOpenclawConfigPath);
      restoreEnvVar("CLAWDBOT_STATE_DIR", previousClawdbotStateDir);
      restoreEnvVar("CLAWDBOT_CONFIG_PATH", previousClawdbotConfigPath);
      sandbox.cleanup();
    }
  });

  it("allocates distinct connector base URLs per local agent", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    seedLocalAgentCredentials(sandbox.homeDir, "beta");

    try {
      const alphaInvite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });
      const betaInvite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB8",
        proxyUrl: "https://alpha.example.com/hooks/agent",
        peerAlias: "alpha",
      });

      const alphaResult = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: alphaInvite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const betaOpenclawDir = join(sandbox.homeDir, "openclaw-beta");
      mkdirSync(betaOpenclawDir, { recursive: true });
      writeFileSync(
        join(betaOpenclawDir, "openclaw.json"),
        JSON.stringify({ hooks: { enabled: false, mappings: [] } }, null, 2),
        "utf8",
      );

      const betaResult = await setupOpenclawRelayFromInvite("beta", {
        inviteCode: betaInvite.code,
        homeDir: sandbox.homeDir,
        openclawDir: betaOpenclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(alphaResult.connectorBaseUrl).toBe("http://127.0.0.1:19400");
      expect(betaResult.connectorBaseUrl).toBe("http://127.0.0.1:19401");
    } finally {
      sandbox.cleanup();
    }
  });

  it("keeps send-to-peer mapping idempotent across repeated setup", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfig = JSON.parse(
        readFileSync(join(sandbox.openclawDir, "openclaw.json"), "utf8"),
      ) as {
        hooks: { mappings?: Array<Record<string, unknown>> };
      };

      const relayMappings = (openclawConfig.hooks.mappings ?? []).filter(
        (mapping) =>
          mapping.id === "clawdentity-send-to-peer" ||
          (mapping.match as { path?: string })?.path === "send-to-peer",
      );
      expect(relayMappings).toHaveLength(1);
    } finally {
      sandbox.cleanup();
    }
  });

  it("preserves existing OpenClaw hooks token and mirrors it to relay runtime config", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const openclawConfigPath = join(sandbox.openclawDir, "openclaw.json");
    writeFileSync(
      openclawConfigPath,
      JSON.stringify(
        {
          hooks: {
            enabled: true,
            token: "existing-hook-token",
            mappings: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfig = JSON.parse(
        readFileSync(openclawConfigPath, "utf8"),
      ) as {
        hooks: { token?: string };
      };
      expect(openclawConfig.hooks.token).toBe("existing-hook-token");

      const relayRuntimeConfig = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawHookToken?: string;
      };
      expect(relayRuntimeConfig.openclawHookToken).toBe("existing-hook-token");
    } finally {
      sandbox.cleanup();
    }
  });

  it("supports self setup without peer routing details", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const peers = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "peers.json"),
          "utf8",
        ),
      ) as {
        peers: Record<
          string,
          {
            did: string;
            proxyUrl: string;
            agentName?: string;
            humanName?: string;
          }
        >;
      };
      expect(peers.peers).toEqual({});
    } finally {
      sandbox.cleanup();
    }
  });
});
