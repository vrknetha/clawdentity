import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { parseFrame, serializeFrame } from "./frames.js";
import { startConnectorRuntime } from "./runtime.js";
import {
  isDeliveryReceiptPost,
  waitForDeliveryReceiptPostFlush,
} from "./runtime.test/helpers.js";

type Sandbox = {
  cleanup: () => void;
  rootDir: string;
};

type WsHarness = {
  cleanup: () => Promise<void>;
  sendDeliverFrame: (input: {
    payload: unknown;
    requestId: string;
    fromAgentDid: string;
    toAgentDid?: string;
  }) => Promise<void>;
  waitForDeliverAck: (requestId: string) => Promise<void>;
  wsUrl: string;
};

const DID_AUTHORITY = "registry.example.test";
const ENV_KEYS = [
  "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
  "CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS",
  "CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS",
] as const;

function createSandbox(): Sandbox {
  const rootDir = mkdtempSync(join(tmpdir(), "clawdentity-connector-runtime-"));
  mkdirSync(join(rootDir, "agents", "alpha"), { recursive: true });

  return {
    rootDir,
    cleanup: () => {
      rmSync(rootDir, {
        force: true,
        recursive: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    },
  };
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate test port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function createWsHarness(port: number): Promise<WsHarness> {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    path: "/v1/relay/connect",
    port,
  });

  const frames: unknown[] = [];
  let socket: import("ws").WebSocket | undefined;

  const connectedPromise = new Promise<void>((resolve) => {
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (payload) => {
        frames.push(parseFrame(payload.toString()));
      });
      resolve();
    });
  });

  const waitForDeliverAck = async (requestId: string): Promise<void> => {
    await vi.waitFor(() => {
      expect(
        frames.some((frame) => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const typed = frame as {
            ackId?: string;
            accepted?: boolean;
            type?: string;
          };
          return (
            typed.type === "deliver_ack" &&
            typed.ackId === requestId &&
            typed.accepted === true
          );
        }),
      ).toBe(true);
    });
  };

  const sendDeliverFrame = async (input: {
    payload: unknown;
    requestId: string;
    fromAgentDid: string;
    toAgentDid?: string;
  }): Promise<void> => {
    await connectedPromise;
    if (socket === undefined) {
      throw new Error("WebSocket connection was not established");
    }

    socket.send(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: input.requestId,
        ts: "2026-02-20T00:00:00.000Z",
        fromAgentDid: input.fromAgentDid,
        toAgentDid:
          input.toAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(2)),
        payload: input.payload,
      }),
    );
  };

  return {
    wsUrl: `ws://127.0.0.1:${port}/v1/relay/connect`,
    sendDeliverFrame,
    waitForDeliverAck,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

function createRuntimeAitToken(input: {
  agentDid: string;
  ownerDid: string;
  issuer: string;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.issuer,
    sub: input.agentDid,
    ownerDid: input.ownerDid,
    name: "alpha",
    framework: "deliveryWebhook",
    cnf: {
      jwk: {
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: encodeBase64url(randomBytes(32)),
      },
    },
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 3600,
    jti: generateUlid(nowSeconds * 1000),
  };
  const header = {
    alg: "EdDSA",
    typ: "AIT",
    kid: "test-registry-kid",
  };

  return [
    encodeBase64url(Buffer.from(JSON.stringify(header), "utf8")),
    encodeBase64url(Buffer.from(JSON.stringify(payload), "utf8")),
    "signature",
  ].join(".");
}

function createRuntimeCredentials(input: { issuer?: string } = {}) {
  const agentDid = makeAgentDid(DID_AUTHORITY, generateUlid(100));
  const ownerDid = makeHumanDid(DID_AUTHORITY, generateUlid(101));

  return {
    agentDid,
    ait: createRuntimeAitToken({
      agentDid,
      ownerDid,
      issuer: input.issuer ?? "https://registry.example.test",
    }),
    secretKey: Buffer.from(randomBytes(32)).toString("base64url"),
    accessToken: "access-token",
    accessExpiresAt: "2100-01-01T00:00:00.000Z",
    refreshToken: "refresh-token",
    refreshExpiresAt: "2100-01-01T00:00:00.000Z",
    tokenType: "Bearer" as const,
  };
}

async function writeRelayRuntimeConfig(input: {
  configDir: string;
  relayTransformPeersPath: string;
}): Promise<void> {
  await writeFile(
    join(input.configDir, "deliveryWebhook-relay.json"),
    `${JSON.stringify(
      { relayTransformPeersPath: input.relayTransformPeersPath },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeRelayTransformPeersSnapshot(input: {
  configDir: string;
  peers: Record<
    string,
    {
      agentName?: string;
      did: string;
      displayName?: string;
      proxyUrl?: string;
    }
  >;
}): Promise<void> {
  await writeFile(
    join(input.configDir, "relay-transform-peers.json"),
    `${JSON.stringify({ peers: input.peers }, null, 2)}\n`,
    "utf8",
  );
}

async function readConnectorStatus(outboundUrl: string): Promise<unknown> {
  const statusUrl = new URL("/v1/status", outboundUrl).toString();
  const response = await fetch(statusUrl);
  if (!response.ok) {
    throw new Error(`status endpoint failed with ${response.status}`);
  }
  return await response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("startConnectorRuntime sender profile headers", () => {
  it("adds sender profile headers from relay peers snapshot during replay delivery", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const senderDid = makeAgentDid(DID_AUTHORITY, generateUlid(300));
    await writeRelayTransformPeersSnapshot({
      configDir: sandbox.rootDir,
      peers: {
        ravi: {
          did: senderDid,
          proxyUrl: "https://proxy.example.test/hooks/message",
          agentName: "ravi-assistant",
          displayName: "Ravi Kiran",
        },
      },
    });
    await writeRelayRuntimeConfig({
      configDir: sandbox.rootDir,
      relayTransformPeersPath: "relay-transform-peers.json",
    });

    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39109";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const hookHeaders: Headers[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookHeaders.push(new Headers(init?.headers));
        return new Response("ok", { status: 200 });
      }

      if (isDeliveryReceiptPost(url, method)) {
        return new Response("ok", { status: 200 });
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      deliveryWebhookBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(207);
      await wsHarness.sendDeliverFrame({
        requestId,
        fromAgentDid: senderDid,
        payload: { message: "profile headers" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: { pending?: { pendingCount?: number } };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(hookHeaders).toHaveLength(1);
      expect(hookHeaders[0]?.get("x-clawdentity-agent-name")).toBe(
        "ravi-assistant",
      );
      expect(hookHeaders[0]?.get("x-clawdentity-display-name")).toBe(
        "Ravi Kiran",
      );
      await waitForDeliveryReceiptPostFlush({
        configDir: sandbox.rootDir,
        fetchMock,
      });
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("omits sender profile headers when relay peers snapshot has no matching sender", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    await writeRelayTransformPeersSnapshot({
      configDir: sandbox.rootDir,
      peers: {
        other: {
          did: makeAgentDid(DID_AUTHORITY, generateUlid(400)),
          proxyUrl: "https://proxy.example.test/hooks/message",
          agentName: "other-assistant",
          displayName: "Other Human",
        },
      },
    });
    await writeRelayRuntimeConfig({
      configDir: sandbox.rootDir,
      relayTransformPeersPath: "relay-transform-peers.json",
    });

    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39110";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const hookHeaders: Headers[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookHeaders.push(new Headers(init?.headers));
        return new Response("ok", { status: 200 });
      }

      if (isDeliveryReceiptPost(url, method)) {
        return new Response("ok", { status: 200 });
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      deliveryWebhookBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(208);
      await wsHarness.sendDeliverFrame({
        requestId,
        fromAgentDid: makeAgentDid(DID_AUTHORITY, generateUlid(401)),
        payload: { message: "no profile headers" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: { pending?: { pendingCount?: number } };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(hookHeaders).toHaveLength(1);
      expect(hookHeaders[0]?.get("x-clawdentity-agent-name")).toBeNull();
      expect(hookHeaders[0]?.get("x-clawdentity-display-name")).toBeNull();
      await waitForDeliveryReceiptPostFlush({
        configDir: sandbox.rootDir,
        fetchMock,
      });
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("aborts in-flight hook delivery when runtime stops", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39104";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    let hookPostStartedResolve: (() => void) | undefined;
    const hookPostStarted = new Promise<void>((resolve) => {
      hookPostStartedResolve = resolve;
    });

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookPostStartedResolve?.();
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }

      if (isDeliveryReceiptPost(url, method)) {
        return new Response("ok", { status: 200 });
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      deliveryWebhookBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(203);
      await wsHarness.sendDeliverFrame({
        requestId,
        fromAgentDid: makeAgentDid(DID_AUTHORITY, generateUlid(203)),
        payload: { message: "shutdown flow" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await hookPostStarted;
      const startedAt = Date.now();
      await runtime.stop();
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(3_000);
    } finally {
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });
});
