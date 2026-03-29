import { generateUlid } from "@clawdentity/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorInboundInbox } from "./inbound-inbox.js";
import { startConnectorRuntime } from "./runtime.js";
import {
  createRuntimeCredentials,
  createSandbox,
  createWsHarness,
  findAvailablePort,
  resetRuntimeTestEnv,
} from "./runtime.test/helpers.js";

afterEach(() => {
  resetRuntimeTestEnv();
});

describe("startConnectorRuntime shutdown behavior", () => {
  it("closes inbound inbox storage during runtime stop", async () => {
    process.env.CONNECTOR_INBOUND_REPLAY_INTERVAL_MS = "20";
    process.env.CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS = "25";
    process.env.CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS = "20";

    const sandbox = createSandbox();
    const wsPort = await findAvailablePort();
    const wsHarness = await createWsHarness(wsPort);
    const outboundPort = await findAvailablePort();
    const openclawBaseUrl = "http://127.0.0.1:39103";
    const closeSpy = vi.spyOn(ConnectorInboundInbox.prototype, "close");

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
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
    });

    try {
      await runtime.stop();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
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
