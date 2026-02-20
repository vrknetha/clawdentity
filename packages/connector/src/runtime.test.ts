import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
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
  waitForDeliverAck: (requestId: string) => Promise<void>;
  wsUrl: string;
};

const ENV_KEYS = [
  "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
  "CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS",
  "CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS",
  "CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS",
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
        fromAgentDid: input.fromAgentDid ?? makeAgentDid(generateUlid(1)),
        toAgentDid: input.toAgentDid ?? makeAgentDid(generateUlid(2)),
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

function createRuntimeCredentials() {
  return {
    agentDid: makeAgentDid(generateUlid(100)),
    ait: "test-ait",
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
    join(configDir, "openclaw-relay.json"),
    `${JSON.stringify({ openclawHookToken: token }, null, 2)}\n`,
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
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39101";
    const openclawHookUrl = `${openclawBaseUrl}/hooks/agent`;
    let probeReachable = false;
    let hookPostCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
        if (!probeReachable) {
          throw new Error("connect ECONNREFUSED");
        }
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === openclawHookUrl) {
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
      openclawBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
      registryUrl: "https://registry.example.test",
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
            openclawGateway?: { reachable?: boolean };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.openclawGateway?.reachable).toBe(false);
        expect(status.inbound?.pending?.pendingCount).toBe(1);
      });

      expect(hookPostCount).toBe(0);

      probeReachable = true;
      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: {
            openclawGateway?: { reachable?: boolean };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.openclawGateway?.reachable).toBe(true);
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
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    await writeRelayRuntimeConfig(sandbox.rootDir, "token-a");
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39102";
    const openclawHookUrl = `${openclawBaseUrl}/hooks/agent`;
    const postTokens: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === openclawHookUrl) {
        const headers = new Headers(init?.headers);
        const token = headers.get("x-openclaw-token") ?? "";
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
      openclawBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
      registryUrl: "https://registry.example.test",
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

  it("preserves explicit hook token over relay runtime config token", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    await writeRelayRuntimeConfig(sandbox.rootDir, "token-from-relay-config");
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39105";
    const openclawHookUrl = `${openclawBaseUrl}/hooks/agent`;
    const postTokens: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === openclawHookUrl) {
        const headers = new Headers(init?.headers);
        postTokens.push(headers.get("x-openclaw-token") ?? "");
        return new Response("ok", { status: 200 });
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      openclawBaseUrl,
      openclawHookToken: "token-from-cli",
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
      registryUrl: "https://registry.example.test",
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
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";
    process.env.CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS = "3";
    process.env.CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS = "5";
    process.env.CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS = "5";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39103";
    const openclawHookUrl = `${openclawBaseUrl}/hooks/agent`;
    let hookPostCount = 0;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === openclawHookUrl) {
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
      openclawBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
      registryUrl: "https://registry.example.test",
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

  it("aborts in-flight hook delivery when runtime stops", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39104";
    const openclawHookUrl = `${openclawBaseUrl}/hooks/agent`;
    let hookPostStartedResolve: (() => void) | undefined;
    const hookPostStarted = new Promise<void>((resolve) => {
      hookPostStartedResolve = resolve;
    });

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
        return new Response("ok", { status: 200 });
      }

      if (method === "POST" && url === openclawHookUrl) {
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

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    });

    const runtime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      openclawBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${outboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
      registryUrl: "https://registry.example.test",
    });

    try {
      const requestId = generateUlid(203);
      await wsHarness.sendDeliverFrame({
        requestId,
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
