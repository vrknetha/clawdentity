import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import relayToPeer, { relayPayloadToPeer } from "./relay-to-peer.js";

type RelaySandbox = {
  cleanup: () => void;
  homeDir: string;
};

function createRelaySandbox(): RelaySandbox {
  const homeDir = mkdtempSync(
    join(tmpdir(), "clawdentity-openclaw-skill-relay-"),
  );
  const clawdentityDir = join(homeDir, ".clawdentity");

  mkdirSync(clawdentityDir, { recursive: true });

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

  return {
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
    homeDir,
  };
}

describe("relay-to-peer transform", () => {
  it("posts outbound relay payload to local connector endpoint", async () => {
    const sandbox = createRelaySandbox();
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
          fetchImpl: fetchMock as typeof fetch,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, requestInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://127.0.0.1:19400/v1/outbound");
      expect(requestInit.method).toBe("POST");
      expect(requestInit.body).toBe(
        JSON.stringify({
          peer: "beta",
          peerDid: "did:claw:agent:01BETA",
          peerProxyUrl: "https://peer.example.com/hooks/agent?source=skill",
          payload: {
            message: "hello",
            metadata: {
              turn: 1,
            },
          },
        }),
      );

      const headers = new Headers(requestInit.headers);
      expect(headers.get("content-type")).toBe("application/json");
    } finally {
      sandbox.cleanup();
    }
  });

  it("supports connector endpoint override", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));

    try {
      const result = await relayPayloadToPeer(
        {
          peer: "beta",
          message: "hello",
        },
        {
          connectorBaseUrl: "http://127.0.0.1:19555",
          connectorPath: "/relay/outbound",
          homeDir: sandbox.homeDir,
          fetchImpl: fetchMock as typeof fetch,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:19555/relay/outbound",
        expect.objectContaining({
          method: "POST",
        }),
      );
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
    const sandbox = createRelaySandbox();

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "unknown",
            message: "hello",
          },
          {
            homeDir: sandbox.homeDir,
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

  it("maps connector 404 response to deterministic error", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            homeDir: sandbox.homeDir,
            fetchImpl: fetchMock as typeof fetch,
          },
        ),
      ).rejects.toThrow("Local connector outbound endpoint is unavailable");
    } finally {
      sandbox.cleanup();
    }
  });

  it("maps connector network failures to deterministic error", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            homeDir: sandbox.homeDir,
            fetchImpl: fetchMock as typeof fetch,
          },
        ),
      ).rejects.toThrow("Local connector outbound relay request failed");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses default export with transform context payload", async () => {
    const payload = { message: "context payload" };
    const result = await relayToPeer({ payload });
    expect(result).toBe(payload);
  });
});
