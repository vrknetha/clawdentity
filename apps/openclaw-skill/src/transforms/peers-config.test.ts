import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  addPeer,
  loadPeersConfig,
  resolvePeersConfigPath,
  savePeersConfig,
} from "./peers-config.js";

const DID_AUTHORITY = "registry.example.test";
const BETA_AGENT_DID = makeAgentDid(DID_AUTHORITY, generateUlid(1700000000000));
const ALPHA_AGENT_DID = makeAgentDid(
  DID_AUTHORITY,
  generateUlid(1700000001000),
);

function createSandbox(): { cleanup: () => void; homeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "clawdentity-openclaw-skill-"));

  return {
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    homeDir: root,
  };
}

describe("peers config", () => {
  it("returns an empty config when peers.json is missing", async () => {
    const sandbox = createSandbox();

    try {
      const config = await loadPeersConfig({ homeDir: sandbox.homeDir });

      expect(config).toEqual({ peers: {} });
      expect(resolvePeersConfigPath({ homeDir: sandbox.homeDir })).toBe(
        join(sandbox.homeDir, ".clawdentity", "peers.json"),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("saves and loads valid peer mappings", async () => {
    const sandbox = createSandbox();

    try {
      await savePeersConfig(
        {
          peers: {
            beta: {
              did: BETA_AGENT_DID,
              proxyUrl: "https://beta.example.com/hooks/agent",
              agentName: "beta",
              humanName: "Ira",
            },
          },
        },
        { homeDir: sandbox.homeDir },
      );

      const loaded = await loadPeersConfig({ homeDir: sandbox.homeDir });
      expect(loaded).toEqual({
        peers: {
          beta: {
            did: BETA_AGENT_DID,
            proxyUrl: "https://beta.example.com/hooks/agent",
            agentName: "beta",
            humanName: "Ira",
          },
        },
      });
    } finally {
      sandbox.cleanup();
    }
  });

  it("adds or replaces peers through addPeer", async () => {
    const sandbox = createSandbox();

    try {
      await addPeer(
        "alpha",
        {
          did: ALPHA_AGENT_DID,
          proxyUrl: "https://alpha.example.com/hooks/agent",
        },
        { homeDir: sandbox.homeDir },
      );

      const loaded = await loadPeersConfig({ homeDir: sandbox.homeDir });
      expect(loaded).toEqual({
        peers: {
          alpha: {
            did: ALPHA_AGENT_DID,
            proxyUrl: "https://alpha.example.com/hooks/agent",
          },
        },
      });
    } finally {
      sandbox.cleanup();
    }
  });

  it("rejects malformed JSON or invalid schema", async () => {
    const sandbox = createSandbox();

    try {
      const configPath = join(sandbox.homeDir, ".clawdentity", "peers.json");
      mkdirSync(join(sandbox.homeDir, ".clawdentity"), { recursive: true });

      writeFileSync(configPath, "{not-json", "utf8");
      await expect(
        loadPeersConfig({ homeDir: sandbox.homeDir }),
      ).rejects.toThrow("not valid JSON");

      writeFileSync(
        configPath,
        JSON.stringify({
          peers: {
            invalid: {
              did: "not-a-did",
              proxyUrl: "not-a-url",
            },
          },
        }),
        "utf8",
      );

      await expect(
        loadPeersConfig({ homeDir: sandbox.homeDir }),
      ).rejects.toThrow("Peer config validation failed");
    } finally {
      sandbox.cleanup();
    }
  });
});
