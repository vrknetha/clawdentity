import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupOpenclawRelay, setupOpenclawSelfReady } from "../openclaw.js";
import {
  createSandbox,
  resolveCliStateDir,
  restoreEnvVar,
  seedLocalAgentCredentials,
  seedPendingGatewayApprovals,
} from "./helpers.js";

describe("openclaw setup helpers (core)", () => {
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
      restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", previousGatewayToken);
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
      restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", previousGatewayToken);
      sandbox.cleanup();
    }
  });

  it("auto-recovers setup checklist when OpenClaw has pending gateway device approvals", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const pendingPath = seedPendingGatewayApprovals(sandbox.openclawDir);

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
    seedPendingGatewayApprovals(sandbox.openclawDir);

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
});
