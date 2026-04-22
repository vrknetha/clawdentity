import { generateUlid } from "@clawdentity/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startConnectorRuntime } from "./runtime.js";
import {
  createRuntimeCredentials,
  createSandbox,
  createWsHarness,
  findAvailablePort,
  readConnectorStatus,
  resetRuntimeTestEnv,
} from "./runtime.test/helpers.js";

afterEach(() => {
  resetRuntimeTestEnv();
});

describe("startConnectorRuntime replay behavior", () => {
  it("replays sqlite-persisted pending messages after a runtime restart", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const restartedOutboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39107";
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
      const requestId = generateUlid(205);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "persist across restart" },
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
    } finally {
      await runtime.stop();
    }

    probeReachable = true;

    const restartedRuntime = await startConnectorRuntime({
      agentName: "alpha",
      configDir: sandbox.rootDir,
      credentials: createRuntimeCredentials(),
      fetchImpl: fetchMock,
      deliveryWebhookBaseUrl,
      outboundBaseUrl: `http://127.0.0.1:${restartedOutboundPort}`,
      proxyWebsocketUrl: wsHarness.wsUrl,
    });

    try {
      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(
          restartedRuntime.outboundUrl,
        )) as {
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
      await restartedRuntime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

  it("reports sqlite-backed pending and dead-letter counts through runtime status", async () => {
    process.env.CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS = "1";
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39108";
    const deliveryWebhookHookUrl = `${deliveryWebhookBaseUrl}/hooks/message`;
    let probeReachable = false;

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
        return new Response("bad request", { status: 400 });
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
      const requestId = generateUlid(206);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: { message: "dead-letter status flow" },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: {
            deadLetter?: { deadLetterCount?: number };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(1);
        expect(status.inbound?.deadLetter?.deadLetterCount).toBe(0);
      });

      probeReachable = true;

      await vi.waitFor(async () => {
        const status = (await readConnectorStatus(runtime.outboundUrl)) as {
          inbound?: {
            deadLetter?: {
              deadLetterCount?: number;
              oldestDeadLetterAt?: string;
            };
            pending?: { pendingCount?: number };
          };
        };
        expect(status.inbound?.pending?.pendingCount).toBe(0);
        expect(status.inbound?.deadLetter?.deadLetterCount).toBe(1);
        expect(status.inbound?.deadLetter?.oldestDeadLetterAt).toBeTruthy();
      });
    } finally {
      await runtime.stop();
      await wsHarness.cleanup();
      sandbox.cleanup();
    }
  });

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

  it("keeps original payload nested under typed delivery payload during replay", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_DELIVERY_WEBHOOK_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const deliveryWebhookBaseUrl = "http://127.0.0.1:39111";
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
      const requestId = generateUlid(207);
      await wsHarness.sendDeliverFrame({
        requestId,
        payload: {
          message: "wake session test",
          sessionId: "thread-beta",
        },
      });
      await wsHarness.waitForDeliverAck(requestId);

      await vi.waitFor(() => {
        expect(hookBodies).toHaveLength(1);
      });
      const payload = hookBodies[0] as {
        type?: string;
        payload?: { sessionId?: string };
      };
      expect(payload.type).toBe("clawdentity.delivery.v1");
      expect(payload.payload?.sessionId).toBe("thread-beta");
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
});
