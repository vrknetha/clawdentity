import { generateUlid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConnectorClient } from "../client.js";
import { parseFrame, serializeFrame } from "../frames.js";
import {
  createMockWebSocketFactory,
  MockWebSocket,
  registerConnectorClientTestHooks,
} from "./helpers.js";

registerConnectorClientTestHooks();

describe("ConnectorClient reconnect behavior", () => {
  it("reconnects when heartbeat acknowledgement times out", async () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const disconnectedEvents: { code: number; reason: string }[] = [];

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 10,
      heartbeatAckTimeoutMs: 25,
      reconnectMinDelayMs: 50,
      reconnectMaxDelayMs: 50,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: (event) => {
          disconnectedEvents.push({ code: event.code, reason: event.reason });
        },
      },
      webSocketFactory,
    });

    client.connect();
    sockets[0].open();

    await vi.advanceTimersByTimeAsync(35);
    expect(sockets).toHaveLength(1);
    expect(disconnectedEvents).toHaveLength(1);
    expect(disconnectedEvents[0]?.reason).toContain(
      "Heartbeat acknowledgement",
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(sockets).toHaveLength(2);

    client.disconnect();
  });

  it("does not reconnect when heartbeat acknowledgement arrives before timeout", async () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 100,
      heartbeatAckTimeoutMs: 40,
      reconnectMinDelayMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory,
    });

    client.connect();
    sockets[0].open();

    await vi.advanceTimersByTimeAsync(100);
    const outboundHeartbeat = parseFrame(sockets[0].sent[0]);
    expect(outboundHeartbeat.type).toBe("heartbeat");
    if (outboundHeartbeat.type !== "heartbeat") {
      throw new Error("expected heartbeat frame");
    }

    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "heartbeat_ack",
        id: generateUlid(1700000000010),
        ts: "2026-01-01T00:00:00.010Z",
        ackId: outboundHeartbeat.id,
      }),
    );

    await vi.advanceTimersByTimeAsync(80);
    expect(disconnected).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);

    client.disconnect();
  });

  it("reconnects when websocket connection does not open before timeout", async () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 30,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory,
    });

    client.connect();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(29);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(sockets).toHaveLength(2);

    client.disconnect();
  });

  it("reconnects after websocket error even when close event is missing", async () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 40,
      reconnectMaxDelayMs: 40,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory,
    });

    client.connect();
    sockets[0].open();
    sockets[0].readyState = 3;
    sockets[0].error(new Error("boom"));

    expect(disconnected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    client.disconnect();
  });

  it("retries websocket upgrade rejection with one immediate retry on 401", async () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const onAuthUpgradeRejected =
      vi.fn<(event: { status: number; immediateRetry: boolean }) => void>();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 100,
      reconnectJitterRatio: 0,
      hooks: {
        onAuthUpgradeRejected,
      },
      webSocketFactory,
    });

    client.connect();
    expect(sockets).toHaveLength(1);

    sockets[0].unexpectedResponse(401);
    await vi.runOnlyPendingTimersAsync();
    expect(sockets).toHaveLength(2);
    expect(onAuthUpgradeRejected).toHaveBeenCalledTimes(1);
    expect(onAuthUpgradeRejected).toHaveBeenNthCalledWith(1, {
      status: 401,
      immediateRetry: true,
    });

    sockets[1].unexpectedResponse(401);
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    expect(onAuthUpgradeRejected).toHaveBeenCalledTimes(2);
    expect(onAuthUpgradeRejected).toHaveBeenNthCalledWith(2, {
      status: 401,
      immediateRetry: false,
    });

    client.disconnect();
  });

  it("reconnects after websocket closes", () => {
    vi.useFakeTimers();

    const { sockets, webSocketFactory } = createMockWebSocketFactory();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 100,
      reconnectJitterRatio: 0,
      webSocketFactory,
    });

    client.connect();
    expect(sockets).toHaveLength(1);

    sockets[0].open();
    sockets[0].failClose(1006, "network down");

    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    client.disconnect();
  });

  it("refreshes connection headers on reconnect attempts", async () => {
    const sockets: MockWebSocket[] = [];
    const dialHeaders: Record<string, string>[] = [];
    let nonceCounter = 0;

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      deliveryWebhookBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 0,
      reconnectMaxDelayMs: 0,
      reconnectJitterRatio: 0,
      connectionHeadersProvider: () => ({
        "x-claw-nonce": `nonce-${++nonceCounter}`,
      }),
      webSocketFactory: (url, headers) => {
        dialHeaders.push(headers);
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(dialHeaders[0]["x-claw-nonce"]).toBe("nonce-1");

    sockets[0].open();
    sockets[0].failClose(1006, "network down");

    await vi.waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    expect(dialHeaders[1]["x-claw-nonce"]).toBe("nonce-2");

    client.disconnect();
  });
});
