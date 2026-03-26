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
  writeRelayRuntimeConfig,
} from "./runtime.test/helpers.js";

afterEach(() => {
  resetRuntimeTestEnv();
});

describe("startConnectorRuntime auth behavior", () => {
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
    const openclawBaseUrl = "http://127.0.0.1:39106";
    const issuerFromAit = "https://registry.example.test/base";
    const expectedRefreshUrl =
      "https://registry.example.test/v1/agents/auth/refresh";
    const refreshCalls: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url === openclawBaseUrl) {
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
      openclawBaseUrl,
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
});
