import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenclawInviteCode,
  decodeOpenclawInviteCode,
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
      expect(openclawConfig.hooks.allowRequestSessionKey).toBe(true);
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
});
