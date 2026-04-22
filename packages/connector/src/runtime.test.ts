/* biome-ignore lint/nursery/noExcessiveLinesPerFile: runtime scenarios share setup and assertions intentionally in one suite. */
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

type Sandbox = {
  cleanup: () => void;
  rootDir: string;
};

type WsHarness = {
  cleanup: () => Promise<void>;
  sendDeliverFrame: (input: {
    payload: unknown;
    requestId: string;
    fromAgentDid?: string;
    toAgentDid?: string;
  }) => Promise<void>;
  sendReceiptFrame: (input: {
    requestId: string;
    status: "delivered_to_webhook" | "dead_lettered";
    toAgentDid?: string;
    reason?: string;
  }) => Promise<void>;
  waitForDeliverAck: (requestId: string) => Promise<void>;
  wsUrl: string;
};

const ENV_KEYS = [
  "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
  "CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS",
  "CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS",
  "CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS",
] as const;
const DID_AUTHORITY = "registry.example.test";

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

  const frames: unknown[] = [];
  let socket: import("ws").WebSocket | undefined;

  const connectedPromise = new Promise<void>((resolve) => {
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (payload) => {
        const text = payload.toString();
        frames.push(parseFrame(text));
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
    fromAgentDid?: string;
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
        fromAgentDid:
          input.fromAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(1)),
        toAgentDid:
          input.toAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(2)),
        payload: input.payload,
      }),
    );
  };

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
    sendDeliverFrame,
    sendReceiptFrame,
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

async function writeRelayRuntimeConfig(configDir: string, token: string) {
  await writeFile(
    join(configDir, "deliveryWebhook-relay.json"),
    `${JSON.stringify({ deliveryWebhookToken: token }, null, 2)}\n`,
    "utf8",
  );
}

async function readConnectorStatus(outboundUrl: string): Promise<unknown> {
  const statusUrl = new URL("/v1/status", outboundUrl).toString();
  const response = await fetch(statusUrl);
  expect(response.status).toBe(200);
  return await response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("startConnectorRuntime", () => {
  it("skips replay while gateway probe is down and resumes after recovery", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39101";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    let probeReachable = false;
    let hookPostCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        if (!probeReachable) {
          throw new Error("connect ECONNREFUSED");
        }
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookPostCount += 1;
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
      const requestId = generateUlid(200);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "queued while gateway down" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: {
            deliveryWebhookGateway?: { reachable?: boolean };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.deliveryWebhookGateway?.reachable).toBe(false);
        expect(status.inbound?.pending?.pendingCount).toBe(1);
      });

      expect(hookPostCount).toBe(0);

      probeReachable = true;
      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: {
            deliveryWebhookGateway?: { reachable?: boolean };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.deliveryWebhookGateway?.reachable).toBe(true);
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(hookPostCount).toBe(1);
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("refreshes hook token from relay runtime config after hook 401", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    await writeRelayRuntimeConfig(sandbox.rootDir, "token-a");
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39102";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const postTokens: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        const headers = new Headers(init?.headers);
        const token = headers.get("x-deliveryWebhook-token") ?? "";
        postTokens.push(token);
        if (postTokens.length === 1) {
          await writeRelayRuntimeConfig(sandbox.rootDir, "token-b");
          return new Response("unauthorized", { status: 401 });
        }
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
      const requestId = generateUlid(201);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "token rotation flow" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: { pending?: { pendingCount?: number } };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(postTokens).toEqual(["token-a", "token-b"]);
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("derives registry refresh URL from AIT issuer claims", async () => {
    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39106";
    const issuerFromAit = "https://registry.example.test/base";
    const expectedRefreshUrl =
      "https://registry.example.test/v1/agents/auth/refresh";
    const refreshCalls: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === expectedRefreshUrl) {
        refreshCalls.push(url);
        return new Response(
          JSON.stringify({
            tokenType: "Bearer",
            accessToken: "refreshed-access-token",
            accessExpiresAt: "2100-01-01T00:00:00.000Z",
            refreshToken: "refreshed-refresh-token",
            refreshExpiresAt: "2100-01-01T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const credentials = createRuntimeCredentials({
      issuer: issuerFromAit,
    });
    credentials.accessToken = "";
    credentials.accessExpiresAt = "1970-01-01T00:00:00.000Z";

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials,
      fetchImpl: fetchMock,
      deliveryWebhookBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      expect(refreshCalls).toEqual([expectedRefreshUrl]);
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("preserves explicit hook token over relay runtime config token", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    await writeRelayRuntimeConfig(sandbox.rootDir, "token-from-relay-config");
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39105";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    const postTokens: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        const headers = new Headers(init?.headers);
        postTokens.push(headers.get("x-deliveryWebhook-token") ?? "");
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
      deliveryWebhookToken: "token-from-cli",
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      const requestId = generateUlid(204);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "explicit token precedence" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: { pending?: { pendingCount?: number } };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(postTokens).toEqual(["token-from-cli"]);
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("retries replay delivery for transient hook failures", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";
    process.env.CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS = "3";
    process.env.CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS = "5";
    process.env.CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS = "5";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39103";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    let hookPostCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === deliveryWebhookBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === deliveryWebhookHookUrl) {
        hookPostCount += 1;
        if (hookPostCount < 3) {
          return new Response("temporary failure", { status: 500 });
        }
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
      const requestId = generateUlid(202);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "retry flow" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: { pending?: { pendingCount?: number } };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
      });
      expect(hookPostCount).toBe(3);
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

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
