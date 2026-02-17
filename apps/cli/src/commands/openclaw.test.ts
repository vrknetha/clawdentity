import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenclawCommand,
  createOpenclawInviteCode,
  decodeOpenclawInviteCode,
  runOpenclawDoctor,
  runOpenclawRelayTest,
  setupOpenclawRelayFromInvite,
} from "./openclaw.js";

type OpenclawSandbox = {
  cleanup: () => void;
  homeDir: string;
  openclawDir: string;
  transformSourcePath: string;
};

function createSandbox(): OpenclawSandbox {
  const root = mkdtempSync(join(tmpdir(), "clawdentity-cli-openclaw-"));
  const homeDir = join(root, "home");
  const openclawDir = join(root, "openclaw");
  const transformSourcePath = join(root, "relay-to-peer.mjs");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(openclawDir, { recursive: true });

  writeFileSync(
    join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        hooks: {
          enabled: false,
          mappings: [],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    transformSourcePath,
    "export default async function relay(ctx){ return ctx?.payload ?? null; }\n",
    "utf8",
  );

  return {
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    homeDir,
    openclawDir,
    transformSourcePath,
  };
}

function seedLocalAgentCredentials(homeDir: string, agentName: string): void {
  const agentDir = join(homeDir, ".clawdentity", "agents", agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "secret.key"), "secret-key-value", "utf8");
  writeFileSync(join(agentDir, "ait.jwt"), "mock.ait.jwt", "utf8");
}

describe("openclaw command helpers", () => {
  it("creates and decodes invite codes", () => {
    const invite = createOpenclawInviteCode({
      did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      proxyUrl: "https://beta.example.com/hooks/agent",
      peerAlias: "beta",
      name: "Beta Agent",
    });

    expect(invite.code.startsWith("clawd1_")).toBe(true);

    const decoded = decodeOpenclawInviteCode(invite.code);
    expect(decoded.v).toBe(1);
    expect(decoded.did).toBe("did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4");
    expect(decoded.proxyUrl).toBe("https://beta.example.com/hooks/agent");
    expect(decoded.alias).toBe("beta");
    expect(decoded.name).toBe("Beta Agent");
    expect(decoded.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("applies relay setup from invite and patches OpenClaw config", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "http://beta-proxy.local:4000/hooks/agent",
        peerAlias: "beta",
        name: "Beta",
      });

      const result = await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.peerAlias).toBe("beta");
      expect(result.peerDid).toBe("did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7");

      const copiedTransform = readFileSync(result.transformTargetPath, "utf8");
      expect(copiedTransform).toContain("relay(ctx)");

      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          enabled?: boolean;
          allowRequestSessionKey?: boolean;
          allowedSessionKeyPrefixes?: string[];
          mappings?: Array<Record<string, unknown>>;
        };
      };

      expect(openclawConfig.hooks.enabled).toBe(true);
      expect(openclawConfig.hooks.allowRequestSessionKey).toBe(false);
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("hook:");
      expect(
        openclawConfig.hooks.mappings?.some(
          (mapping) =>
            mapping.id === "clawdentity-send-to-peer" &&
            (mapping.match as { path?: string })?.path === "send-to-peer" &&
            mapping.action === "agent" &&
            mapping.wakeMode === "now" &&
            (mapping.transform as { module?: string })?.module ===
              "relay-to-peer.mjs",
        ),
      ).toBe(true);

      const peers = JSON.parse(
        readFileSync(
          join(sandbox.homeDir, ".clawdentity", "peers.json"),
          "utf8",
        ),
      ) as {
        peers: Record<string, { did: string; proxyUrl: string; name?: string }>;
      };
      expect(peers.peers.beta).toEqual({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "http://beta-proxy.local:4000/hooks/agent",
        name: "Beta",
      });

      const selectedAgent = readFileSync(
        join(sandbox.homeDir, ".clawdentity", "openclaw-agent-name"),
        "utf8",
      ).trim();
      expect(selectedAgent).toBe("alpha");

      expect(result.openclawBaseUrl).toBe("http://127.0.0.1:18789");
      const relayRuntimeConfig = JSON.parse(
        readFileSync(
          join(sandbox.homeDir, ".clawdentity", "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawBaseUrl: string;
        updatedAt: string;
      };
      expect(relayRuntimeConfig.openclawBaseUrl).toBe("http://127.0.0.1:18789");
      expect(relayRuntimeConfig.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      sandbox.cleanup();
    }
  });

  it("stores explicit OpenClaw base URL in relay runtime config", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
          join(sandbox.homeDir, ".clawdentity", "openclaw-relay.json"),
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
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
          join(sandbox.homeDir, ".clawdentity", "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawBaseUrl: string;
      };
      expect(relayRuntimeConfig.openclawBaseUrl).toBe("http://127.0.0.1:19555");
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.OPENCLAW_BASE_URL;
      } else {
        process.env.OPENCLAW_BASE_URL = previousBaseUrl;
      }
      sandbox.cleanup();
    }
  });

  it("keeps send-to-peer mapping idempotent across repeated setup", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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

  it("requires peer alias when invite code omits it", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
      });

      await expect(
        setupOpenclawRelayFromInvite("alpha", {
          inviteCode: invite.code,
          homeDir: sandbox.homeDir,
          openclawDir: sandbox.openclawDir,
          transformSource: sandbox.transformSourcePath,
        }),
      ).rejects.toThrow(
        "Peer alias is required. Include alias in invite code or pass --peer-alias.",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("reports healthy doctor status when relay setup is complete", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
      });

      expect(result.status).toBe("healthy");
      expect(result.checks.every((check) => check.status === "pass")).toBe(
        true,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("reports missing peer alias in doctor output", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
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
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
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

  it("applies --peer filter for doctor command", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const originalHome = process.env.HOME;
    const originalExitCode = process.exitCode;

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const configPath = join(sandbox.homeDir, ".clawdentity", "config.json");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            registryUrl: "https://api.example.com",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
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

  it("returns relay test success for accepted probe", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () => new Response(null, { status: 204 }),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
      });

      expect(result.status).toBe("success");
      expect(result.httpStatus).toBe(204);
      expect(result.endpoint).toBe("http://127.0.0.1:18789/hooks/send-to-peer");
    } finally {
      sandbox.cleanup();
    }
  });

  it("returns relay test failure when probe is rejected", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () =>
          new Response("connector offline", { status: 500 }),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          apiKey: "test-api-key",
        }),
      });

      expect(result.status).toBe("failure");
      expect(result.httpStatus).toBe(500);
      expect(result.message).toBe(
        "Relay probe failed inside local relay pipeline",
      );
    } finally {
      sandbox.cleanup();
    }
  });
});
