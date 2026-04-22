import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { serializeFrame } from "./frames.js";
import { startConnectorRuntime } from "./runtime.js";

type Sandbox = {
  cleanup: () => void;
  rootDir: string;
};

type WsHarness = {
  cleanup: () => Promise<void>;
  sendReceiptFrame: (input: {
    requestId: string;
    status: "delivered_to_webhook" | "dead_lettered";
    toAgentDid?: string;
    reason?: string;
  }) => Promise<void>;
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
      rmSync(rootDir, { force: true, recursive: true });
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

  let socket: import("ws").WebSocket | undefined;

  const connectedPromise = new Promise<void>((resolve) => {
    wss.on("connection", (ws) => {
      socket = ws;
      resolve();
    });
  });

  const sendReceiptFrame = async (input: {
    requestId: string;
    status: "delivered_to_webhook" | "dead_lettered";
    toAgentDid?: string;
    reason?: string;
  }): Promise<void> => {
    await connectedPromise;
    if (socket === undefined) {
      throw new Error("WebSocket connection was not established");
    }

    socket.send(
      serializeFrame({
        v: 1,
        type: "receipt",
        id: generateUlid(1700000000200),
        ts: "2026-02-20T00:00:00.000Z",
        originalFrameId: input.requestId,
        toAgentDid:
          input.toAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(3)),
        status: input.status,
        reason: input.reason,
      }),
    );
  };

  return {
    wsUrl: `ws://127.0.0.1:${port}/v1/relay/connect`,
    sendReceiptFrame,
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("startConnectorRuntime receipt forwarding", () => {
  it("forwards receipt frames to /hooks/message with typed receipt payload", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39107";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const hookBodies: unknown[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookBodies.push(JSON.parse(String(init?.body ?? "{}")));
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
      deliveryWebhookPath: "/hooks/message",
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(205);
      await wsHarness.sendReceiptFrame({
        requestId,
        status: "dead_lettered",
        reason: "hook rejected",
      });

      await vi.waitFor(() => {
        expect(hookBodies).toHaveLength(1);
      });

      const payload = hookBodies[0] as {
        type?: string;
        status?: string;
        requestId?: string;
        toAgentDid?: string;
        reason?: string;
        relayMetadata?: { timestamp?: string };
      };
      expect(payload.type).toBe("clawdentity.receipt.v1");
      expect(payload.requestId).toBe(requestId);
      expect(payload.status).toBe("dead_lettered");
      expect(payload.reason).toBe("hook rejected");
      expect(payload.toAgentDid).toMatch(/^did:cdi:/);
      expect(payload.relayMetadata?.timestamp).toBe("2026-02-20T00:00:00.000Z");
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("forwards delivered receipt frames with typed status contract", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39108";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const hookBodies: unknown[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookBodies.push(JSON.parse(String(init?.body ?? "{}")));
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
      deliveryWebhookPath: "/hooks/message",
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(206);
      await wsHarness.sendReceiptFrame({
        requestId,
        status: "delivered_to_webhook",
      });

      await vi.waitFor(() => {
        expect(hookBodies).toHaveLength(1);
      });

      const payload = hookBodies[0] as {
        type?: string;
        requestId?: string;
        status?: string;
        relayMetadata?: { timestamp?: string };
      };
      expect(payload.type).toBe("clawdentity.receipt.v1");
      expect(payload.requestId).toBe(requestId);
      expect(payload.status).toBe("delivered_to_webhook");
      expect(payload.relayMetadata?.timestamp).toBe("2026-02-20T00:00:00.000Z");
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });
});
