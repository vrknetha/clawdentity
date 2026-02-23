import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenclawCommand,
  createOpenclawInviteCode,
  runOpenclawDoctor,
  setupOpenclawRelay,
  setupOpenclawRelayFromInvite,
} from "../openclaw.js";
import {
  connectorReadyFetch,
  createSandbox,
  resolveCliStateDir,
  resolveConfigFixture,
  seedLocalAgentCredentials,
  seedPendingGatewayApprovals,
} from "./helpers.js";

describe("openclaw doctor helpers", () => {
  it("reports healthy doctor status when relay setup is complete", async () => {
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

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("healthy");
      expect(result.checks.every((check) => check.status === "pass")).toBe(
        true,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("reports healthy doctor status when setup is complete without peers", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("healthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.peers" &&
            check.status === "pass" &&
            check.message ===
              "no peers are configured yet (optional until pairing)",
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("reports missing peer alias in doctor output", async () => {
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

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        peerAlias: "gamma",
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.peers" &&
            check.status === "fail" &&
            check.message.includes("peer alias is missing: gamma"),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("does not throw when CLI config resolution fails", async () => {
    const sandbox = createSandbox();

    try {
      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        resolveConfigImpl: async () => {
          throw new Error("invalid config");
        },
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "config.registry" &&
            check.status === "fail" &&
            check.message === "unable to resolve CLI config",
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor hook mapping check when mapping path is wrong", async () => {
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

      const openclawConfigPath = join(sandbox.openclawDir, "openclaw.json");
      const openclawConfig = JSON.parse(
        readFileSync(openclawConfigPath, "utf8"),
      ) as {
        hooks: { mappings?: Array<Record<string, unknown>> };
      };
      const mappings = openclawConfig.hooks.mappings ?? [];
      const targetMapping = mappings.find(
        (mapping) => mapping.id === "clawdentity-send-to-peer",
      );
      if (targetMapping === undefined) {
        throw new Error("expected clawdentity-send-to-peer mapping");
      }
      targetMapping.match = { path: "not-send-to-peer" };
      writeFileSync(openclawConfigPath, JSON.stringify(openclawConfig), "utf8");

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.hookMapping" && check.status === "fail",
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor hook session routing check when hook session constraints drift", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfigPath = join(sandbox.openclawDir, "openclaw.json");
      const openclawConfig = JSON.parse(
        readFileSync(openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          allowRequestSessionKey?: boolean;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      openclawConfig.hooks.allowRequestSessionKey = true;
      openclawConfig.hooks.allowedSessionKeyPrefixes = ["hook:"];
      writeFileSync(
        openclawConfigPath,
        `${JSON.stringify(openclawConfig, null, 2)}\n`,
        "utf8",
      );

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.hookSessionRouting" &&
            check.status === "fail" &&
            check.message.includes("hooks.allowRequestSessionKey is not false"),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor hook session routing check when default session uses canonical agent format", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfigPath = join(sandbox.openclawDir, "openclaw.json");
      const openclawConfig = JSON.parse(
        readFileSync(openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          defaultSessionKey?: string;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      openclawConfig.hooks.defaultSessionKey = "agent:main:main";
      openclawConfig.hooks.allowedSessionKeyPrefixes = [
        "hook:",
        "agent:main:main",
      ];
      writeFileSync(
        openclawConfigPath,
        `${JSON.stringify(openclawConfig, null, 2)}\n`,
        "utf8",
      );

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.hookSessionRouting" &&
            check.status === "fail" &&
            check.message.includes("canonical agent format"),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor when OpenClaw has pending gateway device approvals", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      seedPendingGatewayApprovals(sandbox.openclawDir);

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.gatewayDevicePairing" &&
            check.status === "fail" &&
            check.message.includes("pending gateway device approvals: 1"),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor when gateway auth token mode is configured without token", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfigPath = join(sandbox.openclawDir, "openclaw.json");
      const openclawConfig = JSON.parse(
        readFileSync(openclawConfigPath, "utf8"),
      ) as {
        gateway?: {
          auth?: {
            mode?: string;
            token?: string;
          };
        };
      };
      openclawConfig.gateway = {
        ...(openclawConfig.gateway ?? {}),
        auth: {
          ...(openclawConfig.gateway?.auth ?? {}),
          mode: "token",
        },
      };
      if (openclawConfig.gateway?.auth) {
        delete openclawConfig.gateway.auth.token;
      }
      writeFileSync(
        openclawConfigPath,
        `${JSON.stringify(openclawConfig, null, 2)}\n`,
        "utf8",
      );

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.gatewayAuth" &&
            check.status === "fail" &&
            check.message.includes("gateway.auth.token is missing"),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails doctor hook health check when connector reports replay failures", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const unhealthyConnectorFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            websocket: {
              connected: true,
            },
            inbound: {
              pending: {
                pendingCount: 2,
                pendingBytes: 512,
                oldestPendingAt: "2026-01-01T00:00:00.000Z",
              },
              deadLetter: {
                deadLetterCount: 0,
                deadLetterBytes: 0,
              },
              replay: {
                lastReplayError:
                  "Local OpenClaw hook rejected payload with status 500",
                replayerActive: false,
              },
              openclawHook: {
                url: "http://127.0.0.1:18789/hooks/agent",
                lastAttemptStatus: "failed",
                lastAttemptAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: unhealthyConnectorFetch,
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("unhealthy");
      expect(
        result.checks.some(
          (check) =>
            check.id === "state.openclawHookHealth" &&
            check.status === "fail" &&
            check.message.includes(
              "connector replay to local OpenClaw hook is failing",
            ),
        ),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("applies --peer filter for doctor command", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;

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

      const configPath = join(
        resolveCliStateDir(sandbox.homeDir),
        "config.json",
      );
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            registryUrl: "https://api.example.com",
            proxyUrl: "https://proxy.example.com",
            apiKey: "test-api-key",
          },
          null,
          2,
        ),
        "utf8",
      );

      const baseline = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });
      expect(baseline.status).toBe("healthy");

      process.env.HOME = sandbox.homeDir;
      process.exitCode = undefined;

      const command = createOpenclawCommand();
      await command.parseAsync(
        ["doctor", "--peer", "gamma", "--openclaw-dir", sandbox.openclawDir],
        { from: "user" },
      );

      expect(process.exitCode).toBe(1);
    } finally {
      process.env.HOME = originalHome;
      process.exitCode = originalExitCode;
      sandbox.cleanup();
    }
  });
});
