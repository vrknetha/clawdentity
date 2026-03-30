import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import relayToPeer, {
  type RelayTransformError,
  relayPayloadToPeer,
} from "./relay-to-peer.js";

const ALPHA_AGENT_DID =
  "did:cdi:registry.example.test:agent:01HF7YAT00W6W7CM7N3W5FDXT4";
const BETA_AGENT_DID =
  "did:cdi:registry.example.test:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";

type RelaySandbox = {
  cleanup: () => void;
  peersConfigPath: string;
  runtimeConfigPath: string;
};

function buildExpectedConversationId(...parts: string[]): string {
  return `pair:${createHash("sha256").update(parts.sort().join("\n"), "utf8").digest("hex")}`;
}

function createRelaySandbox(): RelaySandbox {
  const runtimeDir = mkdtempSync(join(tmpdir(), "clawdentity-openclaw-skill-"));
  mkdirSync(runtimeDir, { recursive: true });

  const peersConfigPath = join(runtimeDir, "clawdentity-peers.json");
  writeFileSync(
    peersConfigPath,
    JSON.stringify(
      {
        peers: {
          beta: {
            did: BETA_AGENT_DID,
            proxyUrl: "https://peer.example.com/hooks/agent?source=skill",
            agentName: "beta",
            humanName: "Ira",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const runtimeConfigPath = join(runtimeDir, "clawdentity-relay.json");
  writeFileSync(
    runtimeConfigPath,
    `${JSON.stringify(
      {
        connectorBaseUrl: "http://127.0.0.1:19400",
        connectorPath: "/v1/outbound",
        connectorStatusPath: "/v1/status",
        localAgentDid: ALPHA_AGENT_DID,
        peersConfigPath,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    cleanup: () => {
      rmSync(runtimeDir, { recursive: true, force: true });
    },
    peersConfigPath,
    runtimeConfigPath,
  };
}

function createHealthyConnectorFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (url, init) => {
    const normalized = typeof url === "string" ? url : url.toString();
    if (normalized.endsWith("/v1/status")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (normalized.endsWith("/v1/outbound")) {
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }

    throw new Error(`Unexpected URL: ${normalized} (${init?.method ?? "GET"})`);
  }) as typeof fetch;
}

describe("relay-to-peer transform", () => {
  it("checks connector health, then posts outbound relay payload", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = createHealthyConnectorFetch();

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
          configPath: sandbox.peersConfigPath,
          fetchImpl: fetchMock,
          runtimeConfigPath: sandbox.runtimeConfigPath,
          connectorHealthCacheTtlMs: 1,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:19400/v1/status",
      );

      const [url, requestInit] = fetchMock.mock.calls[1] as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://127.0.0.1:19400/v1/outbound");
      expect(requestInit.method).toBe("POST");
      expect(requestInit.body).toBe(
        JSON.stringify({
          conversationId: buildExpectedConversationId(
            ALPHA_AGENT_DID,
            BETA_AGENT_DID,
          ),
          toAgentDid: BETA_AGENT_DID,
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

  it("supports connector endpoint and status path overrides", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const normalized = typeof url === "string" ? url : url.toString();
      if (normalized.endsWith("/relay/status")) {
        return new Response("ok", { status: 200 });
      }
      if (normalized.endsWith("/relay/outbound")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`unexpected URL ${normalized}`);
    });

    try {
      const result = await relayPayloadToPeer(
        {
          peer: "beta",
          message: "hello",
        },
        {
          connectorBaseUrl: "http://127.0.0.1:19555",
          connectorPath: "/relay/outbound",
          connectorStatusPath: "/relay/status",
          configPath: sandbox.peersConfigPath,
          fetchImpl: fetchMock as typeof fetch,
          runtimeConfigPath: sandbox.runtimeConfigPath,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:19555/relay/status",
        expect.objectContaining({
          method: "GET",
        }),
      );
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

  it("forwards groupId payload to local connector without peer resolution", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = createHealthyConnectorFetch();

    try {
      const result = await relayPayloadToPeer(
        {
          groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
          message: "hello group",
        },
        {
          fetchImpl: fetchMock,
          runtimeConfigPath: sandbox.runtimeConfigPath,
          connectorHealthCacheTtlMs: 1,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(requestInit.body).toBe(
        JSON.stringify({
          groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
          payload: {
            message: "hello group",
          },
        }),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("accepts group field as alias for groupId", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = createHealthyConnectorFetch();

    try {
      const result = await relayPayloadToPeer(
        {
          group: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
          message: "hello group",
        },
        {
          fetchImpl: fetchMock,
          runtimeConfigPath: sandbox.runtimeConfigPath,
          connectorHealthCacheTtlMs: 1,
        },
      );

      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(requestInit.body).toBe(
        JSON.stringify({
          groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
          payload: {
            message: "hello group",
          },
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

  it("rejects mixed direct and group routing fields", async () => {
    const sandbox = createRelaySandbox();

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
            message: "hello",
          },
          {
            configPath: sandbox.peersConfigPath,
            fetchImpl: createHealthyConnectorFetch(),
            runtimeConfigPath: sandbox.runtimeConfigPath,
          },
        ),
      ).rejects.toThrow("Provide either peer or groupId/group, not both");
    } finally {
      sandbox.cleanup();
    }
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
            configPath: sandbox.peersConfigPath,
            fetchImpl: createHealthyConnectorFetch(),
          },
        ),
      ).rejects.toThrow("Peer alias is not configured");
    } finally {
      sandbox.cleanup();
    }
  });

  it("maps connector 404 response to deterministic error", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const normalized = typeof url === "string" ? url : url.toString();
      if (normalized.endsWith("/v1/status")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            connectorBaseUrl: "http://127.0.0.1:19557",
            configPath: sandbox.peersConfigPath,
            fetchImpl: fetchMock as typeof fetch,
            runtimeConfigPath: sandbox.runtimeConfigPath,
            connectorHealthCacheTtlMs: 1,
          },
        ),
      ).rejects.toThrow("Local connector outbound endpoint is unavailable");
    } finally {
      sandbox.cleanup();
    }
  });

  it("does not mark endpoint unhealthy after outbound payload rejection", async () => {
    const sandbox = createRelaySandbox();
    let outboundAttempt = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const normalized = typeof url === "string" ? url : url.toString();
      if (normalized.endsWith("/v1/status")) {
        return new Response("ok", { status: 200 });
      }
      if (normalized.endsWith("/v1/outbound")) {
        outboundAttempt += 1;
        if (outboundAttempt === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "invalid payload",
              },
            }),
            { status: 422 },
          );
        }
        return new Response("", { status: 202 });
      }
      throw new Error(`unexpected URL ${normalized}`);
    });

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "bad first",
          },
          {
            connectorBaseUrl: "http://127.0.0.1:19556",
            configPath: sandbox.peersConfigPath,
            fetchImpl: fetchMock as typeof fetch,
            runtimeConfigPath: sandbox.runtimeConfigPath,
            connectorHealthCacheTtlMs: 30_000,
          },
        ),
      ).rejects.toMatchObject({
        category: "connector_request_rejected",
      } satisfies Partial<RelayTransformError>);

      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "good second",
          },
          {
            connectorBaseUrl: "http://127.0.0.1:19556",
            configPath: sandbox.peersConfigPath,
            fetchImpl: fetchMock as typeof fetch,
            runtimeConfigPath: sandbox.runtimeConfigPath,
            connectorHealthCacheTtlMs: 30_000,
          },
        ),
      ).resolves.toBeNull();
      expect(outboundAttempt).toBe(2);
    } finally {
      sandbox.cleanup();
    }
  });

  it("maps connector timeout failures to structured relay error", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const normalized = typeof url === "string" ? url : url.toString();
      if (normalized.endsWith("/v1/status")) {
        return new Response("ok", { status: 200 });
      }

      const timeoutError = new Error("timed out");
      timeoutError.name = "TimeoutError";
      throw timeoutError;
    });

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            configPath: sandbox.peersConfigPath,
            fetchImpl: fetchMock as typeof fetch,
            runtimeConfigPath: sandbox.runtimeConfigPath,
            connectorHealthCacheTtlMs: 1,
          },
        ),
      ).rejects.toMatchObject({
        category: "connector_timeout",
        retryable: true,
      } satisfies Partial<RelayTransformError>);
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails fast when all connector health checks fail", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = vi.fn<typeof fetch>(async () => {
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
            connectorBaseUrl: "http://127.0.0.1:19557",
            configPath: sandbox.peersConfigPath,
            fetchImpl: fetchMock as typeof fetch,
            runtimeConfigPath: sandbox.runtimeConfigPath,
            connectorHealthCacheTtlMs: 1,
          },
        ),
      ).rejects.toThrow("Local connector status endpoint is unavailable");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses explicit payload conversationId as relay lane override", async () => {
    const sandbox = createRelaySandbox();
    const fetchMock = createHealthyConnectorFetch();

    try {
      await relayPayloadToPeer(
        {
          peer: "beta",
          conversationId: "channel:ops-thread-7",
          message: "hello",
        },
        {
          configPath: sandbox.peersConfigPath,
          fetchImpl: fetchMock as typeof fetch,
          runtimeConfigPath: sandbox.runtimeConfigPath,
          connectorHealthCacheTtlMs: 1,
        },
      );

      const [, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(requestInit.body).toBe(
        JSON.stringify({
          conversationId: "channel:ops-thread-7",
          toAgentDid: BETA_AGENT_DID,
          payload: {
            conversationId: "channel:ops-thread-7",
            message: "hello",
          },
        }),
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails clearly when localAgentDid is unavailable for derived relay lanes", async () => {
    const sandbox = createRelaySandbox();

    try {
      await expect(
        relayPayloadToPeer(
          {
            peer: "beta",
            message: "hello",
          },
          {
            configPath: sandbox.peersConfigPath,
            fetchImpl: createHealthyConnectorFetch(),
          },
        ),
      ).rejects.toThrow(
        "OpenClaw relay runtime is missing localAgentDid. Re-run `clawdentity provider setup --for openclaw --agent-name <agent-name>`.",
      );
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
