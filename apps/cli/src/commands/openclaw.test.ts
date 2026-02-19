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
  setupOpenclawRelay,
  setupOpenclawRelayFromInvite,
  setupOpenclawSelfReady,
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

function resolveCliStateDir(homeDir: string): string {
  return join(homeDir, ".clawdentity", "states", "prod");
}

function seedLocalAgentCredentials(homeDir: string, agentName: string): void {
  const agentDir = join(resolveCliStateDir(homeDir), "agents", agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "secret.key"), "secret-key-value", "utf8");
  writeFileSync(join(agentDir, "ait.jwt"), "mock.ait.jwt", "utf8");
}

function seedPeersConfig(
  homeDir: string,
  peers: Record<
    string,
    { did: string; proxyUrl: string; agentName?: string; humanName?: string }
  >,
): void {
  const peersPath = join(resolveCliStateDir(homeDir), "peers.json");
  mkdirSync(dirname(peersPath), { recursive: true });
  writeFileSync(peersPath, `${JSON.stringify({ peers }, null, 2)}\n`, "utf8");
}

function connectorReadyFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        status: "ok",
        websocketConnected: true,
        inboundInbox: {
          pendingCount: 0,
          pendingBytes: 0,
          replayerActive: false,
        },
        openclawHook: {
          url: "http://127.0.0.1:18789/hooks/agent",
          lastAttemptStatus: "ok",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
}

describe("openclaw command helpers", () => {
  it("creates and decodes invite codes", () => {
    const invite = createOpenclawInviteCode({
      did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      proxyUrl: "https://beta.example.com/hooks/agent",
      peerAlias: "beta",
      agentName: "beta",
      humanName: "Ira",
    });

    expect(invite.code.startsWith("clawd1_")).toBe(true);

    const decoded = decodeOpenclawInviteCode(invite.code);
    expect(decoded.v).toBe(1);
    expect(decoded.did).toBe("did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4");
    expect(decoded.proxyUrl).toBe("https://beta.example.com/hooks/agent");
    expect(decoded.alias).toBe("beta");
    expect(decoded.agentName).toBe("beta");
    expect(decoded.humanName).toBe("Ira");
    expect(decoded.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("applies relay setup and patches OpenClaw config", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const copiedTransform = readFileSync(result.transformTargetPath, "utf8");
      expect(copiedTransform).toContain("relay(ctx)");
      expect(result.openclawConfigChanged).toBe(true);

      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        gateway?: {
          auth?: {
            mode?: string;
            token?: string;
          };
        };
        hooks: {
          enabled?: boolean;
          token?: string;
          defaultSessionKey?: string;
          allowRequestSessionKey?: boolean;
          allowedSessionKeyPrefixes?: string[];
          mappings?: Array<Record<string, unknown>>;
        };
      };

      expect(openclawConfig.hooks.enabled).toBe(true);
      expect(typeof openclawConfig.hooks.token).toBe("string");
      expect(openclawConfig.hooks.token?.length ?? 0).toBeGreaterThan(0);
      expect(openclawConfig.hooks.defaultSessionKey).toBe("main");
      expect(openclawConfig.hooks.allowRequestSessionKey).toBe(false);
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("hook:");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("main");
      expect(openclawConfig.gateway?.auth?.mode).toBe("token");
      expect(typeof openclawConfig.gateway?.auth?.token).toBe("string");
      expect(openclawConfig.gateway?.auth?.token?.length ?? 0).toBeGreaterThan(
        0,
      );
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

      const selectedAgent = readFileSync(
        join(resolveCliStateDir(sandbox.homeDir), "openclaw-agent-name"),
        "utf8",
      ).trim();
      expect(selectedAgent).toBe("alpha");

      expect(result.openclawBaseUrl).toBe("http://127.0.0.1:18789");
      expect(result.connectorBaseUrl).toBe("http://127.0.0.1:19400");
      expect(readFileSync(result.relayTransformRuntimePath, "utf8")).toContain(
        '"connectorBaseUrl": "http://host.docker.internal:19400"',
      );
      expect(readFileSync(result.relayTransformPeersPath, "utf8")).toContain(
        '"peers": {}',
      );
      const relayRuntimeConfig = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-relay.json"),
          "utf8",
        ),
      ) as {
        openclawBaseUrl: string;
        openclawHookToken?: string;
        relayTransformPeersPath?: string;
        updatedAt: string;
      };
      expect(relayRuntimeConfig.openclawBaseUrl).toBe("http://127.0.0.1:18789");
      expect(relayRuntimeConfig.openclawHookToken).toBe(
        openclawConfig.hooks.token,
      );
      expect(relayRuntimeConfig.relayTransformPeersPath).toBe(
        result.relayTransformPeersPath,
      );
      expect(relayRuntimeConfig.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const connectorAssignments = JSON.parse(
        readFileSync(
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-connectors.json"),
          "utf8",
        ),
      ) as {
        agents: Record<string, { connectorBaseUrl: string; updatedAt: string }>;
      };
      expect(connectorAssignments.agents.alpha.connectorBaseUrl).toBe(
        "http://127.0.0.1:19400",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("does not rewrite OpenClaw config when setup state is already current", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const preconfiguredOpenclawJson =
      '{"hooks":{"enabled":true,"token":"hook-token","defaultSessionKey":"main","allowRequestSessionKey":false,"allowedSessionKeyPrefixes":["hook:","main"],"mappings":[{"id":"clawdentity-send-to-peer","match":{"path":"send-to-peer"},"action":"agent","wakeMode":"now","transform":{"module":"relay-to-peer.mjs"}}]},"gateway":{"auth":{"mode":"token","token":"gateway-token"}}}\n';
    writeFileSync(
      join(sandbox.openclawDir, "openclaw.json"),
      preconfiguredOpenclawJson,
      "utf8",
    );

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      expect(result.openclawConfigChanged).toBe(false);
      expect(readFileSync(result.openclawConfigPath, "utf8")).toBe(
        preconfiguredOpenclawJson,
      );
    } finally {
      if (previousGatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
      }
      sandbox.cleanup();
    }
  });

  it("supports setup-only mode without runtime startup", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const result = await setupOpenclawSelfReady("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
        noRuntimeStart: true,
      });

      expect(result.runtimeMode).toBe("none");
      expect(result.runtimeStatus).toBe("skipped");
      expect(result.websocketStatus).toBe("skipped");
      expect(readFileSync(result.transformTargetPath, "utf8")).toContain(
        "relay(ctx)",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("syncs gateway auth token from OPENCLAW_GATEWAY_TOKEN during setup", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token-from-env";

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });

      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        gateway?: {
          auth?: {
            mode?: string;
            token?: string;
          };
        };
      };

      expect(openclawConfig.gateway?.auth?.mode).toBe("token");
      expect(openclawConfig.gateway?.auth?.token).toBe(
        "gateway-token-from-env",
      );
    } finally {
      if (previousGatewayToken === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
      }
      sandbox.cleanup();
    }
  });

  it("auto-recovers setup checklist when OpenClaw has pending gateway device approvals", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const pendingPath = join(sandbox.openclawDir, "devices", "pending.json");
    mkdirSync(dirname(pendingPath), { recursive: true });
    writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          "request-1": {
            requestId: "request-1",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const approvedRequestIds: string[] = [];
      const result = await setupOpenclawSelfReady("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
        noRuntimeStart: true,
        gatewayDeviceApprovalRunner: async ({ requestId }) => {
          approvedRequestIds.push(requestId);
          writeFileSync(pendingPath, JSON.stringify({}, null, 2), "utf8");
          return {
            ok: true,
          };
        },
      });

      expect(result.runtimeMode).toBe("none");
      expect(approvedRequestIds).toEqual(["request-1"]);
      const pendingAfterRecovery = JSON.parse(
        readFileSync(pendingPath, "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(pendingAfterRecovery)).toHaveLength(0);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails setup checklist when gateway approval runner is unavailable", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const pendingPath = join(sandbox.openclawDir, "devices", "pending.json");
    mkdirSync(dirname(pendingPath), { recursive: true });
    writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          "request-1": {
            requestId: "request-1",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      await expect(
        setupOpenclawSelfReady("alpha", {
          homeDir: sandbox.homeDir,
          openclawDir: sandbox.openclawDir,
          transformSource: sandbox.transformSourcePath,
          noRuntimeStart: true,
          gatewayDeviceApprovalRunner: async () => ({
            ok: false,
            unavailable: true,
            errorMessage: "spawn openclaw ENOENT",
          }),
        }),
      ).rejects.toMatchObject({
        code: "CLI_OPENCLAW_SETUP_CHECKLIST_FAILED",
      });
    } finally {
      sandbox.cleanup();
    }
  });

  it("preserves explicit hook request session key (including subagent keys)", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    writeFileSync(
      join(sandbox.openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          hooks: {
            enabled: true,
            token: "existing-token",
            defaultSessionKey: "subagent:planner",
            allowedSessionKeyPrefixes: ["hook:"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          token?: string;
          defaultSessionKey?: string;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      expect(openclawConfig.hooks.token).toBe("existing-token");
      expect(openclawConfig.hooks.defaultSessionKey).toBe("subagent:planner");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("hook:");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain(
        "subagent:planner",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("normalizes legacy canonical hook default session key to request format", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    writeFileSync(
      join(sandbox.openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          hooks: {
            enabled: true,
            token: "existing-token",
            defaultSessionKey: "agent:ops:subagent:planner",
            allowedSessionKeyPrefixes: ["hook:"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          token?: string;
          defaultSessionKey?: string;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      expect(openclawConfig.hooks.token).toBe("existing-token");
      expect(openclawConfig.hooks.defaultSessionKey).toBe("subagent:planner");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("hook:");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain(
        "subagent:planner",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("derives hook default session key from OpenClaw session scope and main key", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    writeFileSync(
      join(sandbox.openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          session: { mainKey: "work" },
          agents: {
            list: [{ id: "main" }, { id: "ops-team", default: true }],
          },
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

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          defaultSessionKey?: string;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      expect(openclawConfig.hooks.defaultSessionKey).toBe("work");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain("work");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses global hook default session when OpenClaw session scope is global", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    writeFileSync(
      join(sandbox.openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          session: { scope: "global" },
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

    try {
      const result = await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      const openclawConfig = JSON.parse(
        readFileSync(result.openclawConfigPath, "utf8"),
      ) as {
        hooks: {
          defaultSessionKey?: string;
          allowedSessionKeyPrefixes?: string[];
        };
      };

      expect(openclawConfig.hooks.defaultSessionKey).toBe("global");
      expect(openclawConfig.hooks.allowedSessionKeyPrefixes).toContain(
        "global",
      );
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
          join(resolveCliStateDir(sandbox.homeDir), "openclaw-relay.json"),
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
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
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
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
      if (previousStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = previousStateDir;
      }
      if (previousConfigPath === undefined) {
        delete process.env.CLAWDBOT_CONFIG_PATH;
      } else {
        process.env.CLAWDBOT_CONFIG_PATH = previousConfigPath;
      }
      if (previousOpenclawStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousOpenclawStateDir;
      }
      if (previousOpenclawConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousOpenclawConfigPath;
      }
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
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
      if (previousOpenclawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenclawHome;
      }
      if (previousOpenclawStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousOpenclawStateDir;
      }
      if (previousOpenclawConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousOpenclawConfigPath;
      }
      if (previousClawdbotStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = previousClawdbotStateDir;
      }
      if (previousClawdbotConfigPath === undefined) {
        delete process.env.CLAWDBOT_CONFIG_PATH;
      } else {
        process.env.CLAWDBOT_CONFIG_PATH = previousClawdbotConfigPath;
      }
      sandbox.cleanup();
    }
  });

  it("allocates distinct connector base URLs per local agent", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    seedLocalAgentCredentials(sandbox.homeDir, "beta");

    try {
      const alphaInvite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });
      const betaInvite = createOpenclawInviteCode({
        did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB8",
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
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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
          proxyUrl: "https://proxy.example.com",
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
          proxyUrl: "https://proxy.example.com",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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

      const pendingPath = join(sandbox.openclawDir, "devices", "pending.json");
      mkdirSync(dirname(pendingPath), { recursive: true });
      writeFileSync(
        pendingPath,
        JSON.stringify(
          {
            "request-1": {
              requestId: "request-1",
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await runOpenclawDoctor({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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
            websocketConnected: true,
            inboundInbox: {
              pendingCount: 2,
              pendingBytes: 512,
              oldestPendingAt: "2026-01-01T00:00:00.000Z",
              lastReplayError:
                "Local OpenClaw hook rejected payload with status 500",
              replayerActive: false,
            },
            openclawHook: {
              url: "http://127.0.0.1:18789/hooks/agent",
              lastAttemptStatus: "failed",
              lastAttemptAt: "2026-01-01T00:00:00.000Z",
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
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
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
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
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () => new Response(null, { status: 204 }),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
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

  it("auto-selects peer for relay test when exactly one peer is configured", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () => new Response(null, { status: 204 }),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
      });

      expect(result.status).toBe("success");
      expect(result.peerAlias).toBe("beta");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses hook token from relay runtime config when relay test option/env is unset", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousHookToken = process.env.OPENCLAW_HOOK_TOKEN;
    delete process.env.OPENCLAW_HOOK_TOKEN;

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
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      let sentHookToken: string | undefined;
      await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async (_input, init) => {
          const headers = new Headers(init?.headers);
          sentHookToken = headers.get("x-openclaw-token") ?? undefined;
          return new Response(null, { status: 204 });
        },
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
          apiKey: "test-api-key",
        }),
      });

      expect(typeof sentHookToken).toBe("string");
      expect(sentHookToken?.length ?? 0).toBeGreaterThan(0);
    } finally {
      if (previousHookToken === undefined) {
        delete process.env.OPENCLAW_HOOK_TOKEN;
      } else {
        process.env.OPENCLAW_HOOK_TOKEN = previousHookToken;
      }
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
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () =>
          new Response("connector offline", { status: 500 }),
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
          proxyUrl: "https://proxy.example.com",
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
