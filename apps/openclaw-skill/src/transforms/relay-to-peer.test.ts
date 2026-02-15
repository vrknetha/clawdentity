import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64url } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import relayToPeer, { relayPayloadToPeer } from "./relay-to-peer.js";

type RelaySandbox = {
  cleanup: () => void;
  homeDir: string;
};

function createRelaySandbox(agentName: string): RelaySandbox {
  const homeDir = mkdtempSync(
    join(tmpdir(), "clawdentity-openclaw-skill-relay-"),
  );
  const clawdentityDir = join(homeDir, ".clawdentity");
  const agentDirectory = join(clawdentityDir, "agents", agentName);

  mkdirSync(agentDirectory, { recursive: true });

  writeFileSync(
    join(clawdentityDir, "peers.json"),
    JSON.stringify(
      {
        peers: {
          beta: {
            did: "did:claw:agent:01BETA",
            proxyUrl: "https://peer.example.com/hooks/agent?source=skill",
            name: "Beta",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(agentDirectory, "secret.key"),
    encodeBase64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    "utf8",
  );
  writeFileSync(join(agentDirectory, "ait.jwt"), "mock.ait.jwt", "utf8");

  return {
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
    homeDir,
  };
}

function writeAgentCredentials(homeDir: string, agentName: string): void {
  const agentDirectory = join(homeDir, ".clawdentity", "agents", agentName);
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    join(agentDirectory, "secret.key"),
    encodeBase64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    "utf8",
  );
  writeFileSync(join(agentDirectory, "ait.jwt"), "mock.ait.jwt", "utf8");
}

describe("relay-to-peer transform", () => {
  it("relays peer payloads with Claw authorization and PoP headers", async () => {
    const sandbox = createRelaySandbox("alpha-agent");
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    try {
      const result = await relayPayloadToPeer(
        {
          peer: "beta",
          message: "hello",
          metadata: {
            turn: 1,
          },
        },
        {
          homeDir: sandbox.homeDir,
          agentName: "alpha-agent",
          fetchImpl: fetchMock as typeof fetch,
          clock: () => 1_700_000_000_000,
          randomBytesImpl: () =>
            Uint8Array.from([
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
            ]),
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, requestInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://peer.example.com/hooks/agent?source=skill");
      expect(requestInit.method).toBe("POST");
      expect(requestInit.body).toBe(
        JSON.stringify({
          message: "hello",
          metadata: {
            turn: 1,
          },
        }),
      );

      const headers = new Headers(requestInit.headers);
      expect(headers.get("authorization")).toBe("Claw mock.ait.jwt");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-claw-timestamp")).toBe("1700000000");
      expect(headers.get("x-claw-nonce")).toBe("AQIDBAUGBwgJCgsMDQ4PEA");
      expect(headers.get("x-claw-body-sha256")).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(headers.get("x-claw-proof")).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      sandbox.cleanup();
    }
  });

  it("returns payload unchanged when peer is not set", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 202 }));

    const payload = {
      message: "local only",
    };

    const result = await relayPayloadToPeer(payload, {
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toBe(payload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the peer alias is unknown", async () => {
    const sandbox = createRelaySandbox("alpha-agent");

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "unknown",
            message: "hello",
          },
          {
            homeDir: sandbox.homeDir,
            agentName: "alpha-agent",
            fetchImpl: vi.fn(
              async () => new Response("", { status: 200 }),
            ) as typeof fetch,
          },
        ),
      ).rejects.toThrow("Peer alias is not configured");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses ~/.clawdentity/openclaw-agent-name when env is missing", async () => {
    const sandbox = createRelaySandbox("alpha-agent");
    const previousAgentName = process.env.CLAWDENTITY_AGENT_NAME;
    delete process.env.CLAWDENTITY_AGENT_NAME;
    writeFileSync(
      join(sandbox.homeDir, ".clawdentity", "openclaw-agent-name"),
      "alpha-agent\n",
      "utf8",
    );

    try {
      const result = await relayPayloadToPeer(
        {
          peer: "beta",
          message: "hello",
        },
        {
          homeDir: sandbox.homeDir,
          fetchImpl: vi.fn(
            async () => new Response("", { status: 200 }),
          ) as typeof fetch,
        },
      );

      expect(result).toBeNull();
    } finally {
      process.env.CLAWDENTITY_AGENT_NAME = previousAgentName;
      sandbox.cleanup();
    }
  });

  it("throws when multiple local agents exist without selection", async () => {
    const sandbox = createRelaySandbox("alpha-agent");
    const previousAgentName = process.env.CLAWDENTITY_AGENT_NAME;
    delete process.env.CLAWDENTITY_AGENT_NAME;
    writeAgentCredentials(sandbox.homeDir, "gamma-agent");

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            homeDir: sandbox.homeDir,
            fetchImpl: vi.fn(
              async () => new Response("", { status: 200 }),
            ) as typeof fetch,
          },
        ),
      ).rejects.toThrow("Multiple local agents found");
    } finally {
      process.env.CLAWDENTITY_AGENT_NAME = previousAgentName;
      sandbox.cleanup();
    }
  });

  it("uses default export with transform context payload", async () => {
    const payload = { message: "context payload" };
    const result = await relayToPeer({ payload });
    expect(result).toBe(payload);
  });
});
