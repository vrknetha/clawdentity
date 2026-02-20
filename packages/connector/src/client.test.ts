import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorClient } from "./client.js";
import { parseFrame, serializeFrame } from "./frames.js";

class MockWebSocket {
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];

  private readonly listeners: Record<string, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
    "unexpected-response": new Set(),
  };

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type]?.add(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("socket is not open");
    }

    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return;
    }

    this.readyState = 3;
    this.emit("close", {
      code,
      reason,
      wasClean: true,
    });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  failClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.emit("close", {
      code,
      reason,
      wasClean: false,
    });
  }

  error(error: unknown): void {
    this.emit("error", { error });
  }

  unexpectedResponse(status: number): void {
    this.emit("unexpected-response", { status });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

function createAgentDid(seedMs: number): string {
  return makeAgentDid(generateUlid(seedMs));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ConnectorClient", () => {
  it("acks inbound heartbeat frames", async () => {
    const sockets: MockWebSocket[] = [];

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    expect(sockets).toHaveLength(1);

    sockets[0].open();

    const heartbeatId = generateUlid(1700000000000);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "heartbeat",
        id: heartbeatId,
        ts: "2026-01-01T00:00:00.000Z",
      }),
    );

    await vi.waitFor(() => {
      expect(sockets[0].sent).toHaveLength(1);
    });

    const outbound = parseFrame(sockets[0].sent[0]);
    expect(outbound.type).toBe("heartbeat_ack");
    if (outbound.type !== "heartbeat_ack") {
      throw new Error("expected heartbeat_ack frame");
    }
    expect(outbound.ackId).toBe(heartbeatId);

    client.disconnect();
  });

  it("forwards deliver frames to local openclaw and acks success", async () => {
    const sockets: MockWebSocket[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      openclawHookToken: "hook-secret",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].open();

    const deliverId = generateUlid(1700000000000);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: deliverId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: createAgentDid(1700000000100),
        toAgentDid: createAgentDid(1700000000200),
        payload: {
          message: "hello from connector",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sockets[0].sent.length).toBeGreaterThan(0);
    });

    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:18789/hooks/agent");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      "content-type": "application/json",
      "x-openclaw-token": "hook-secret",
      "x-request-id": deliverId,
    });

    const ack = parseFrame(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(ack.type).toBe("deliver_ack");
    if (ack.type !== "deliver_ack") {
      throw new Error("expected deliver_ack frame");
    }
    expect(ack.ackId).toBe(deliverId);
    expect(ack.accepted).toBe(true);

    client.disconnect();
  });

  it("acks delivery failure when local openclaw rejects", async () => {
    const sockets: MockWebSocket[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad", { status: 400 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].open();

    const deliverId = generateUlid(1700000000000);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: deliverId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: createAgentDid(1700000000100),
        toAgentDid: createAgentDid(1700000000200),
        payload: {
          message: "hello from connector",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sockets[0].sent.length).toBeGreaterThan(0);
    });

    const ack = parseFrame(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(ack.type).toBe("deliver_ack");
    if (ack.type !== "deliver_ack") {
      throw new Error("expected deliver_ack frame");
    }
    expect(ack.ackId).toBe(deliverId);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toContain("status 400");

    client.disconnect();
  });

  it("acks success when inbound delivery handler persists payload", async () => {
    const sockets: MockWebSocket[] = [];
    const fetchMock = vi.fn<typeof fetch>();
    const inboundDeliverHandler = vi.fn(async () => ({ accepted: true }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      inboundDeliverHandler,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].open();

    const deliverId = generateUlid(1700000000000);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: deliverId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: createAgentDid(1700000000100),
        toAgentDid: createAgentDid(1700000000200),
        payload: { message: "persist me" },
      }),
    );

    await vi.waitFor(() => {
      expect(inboundDeliverHandler).toHaveBeenCalledTimes(1);
      expect(sockets[0].sent.length).toBeGreaterThan(0);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const ack = parseFrame(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(ack.type).toBe("deliver_ack");
    if (ack.type !== "deliver_ack") {
      throw new Error("expected deliver_ack frame");
    }
    expect(ack.ackId).toBe(deliverId);
    expect(ack.accepted).toBe(true);

    client.disconnect();
  });

  it("retries transient local openclaw failures and eventually acks success", async () => {
    const sockets: MockWebSocket[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:18789"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:18789"))
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      openclawDeliverTimeoutMs: 100,
      openclawDeliverRetryInitialDelayMs: 1,
      openclawDeliverRetryMaxDelayMs: 2,
      openclawDeliverRetryBudgetMs: 500,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0].open();

    const deliverId = generateUlid(1700000000000);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: deliverId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: createAgentDid(1700000000100),
        toAgentDid: createAgentDid(1700000000200),
        payload: {
          message: "hello from connector",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sockets[0].sent.length).toBeGreaterThan(0);
    });

    const ack = parseFrame(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(ack.type).toBe("deliver_ack");
    if (ack.type !== "deliver_ack") {
      throw new Error("expected deliver_ack frame");
    }
    expect(ack.ackId).toBe(deliverId);
    expect(ack.accepted).toBe(true);

    client.disconnect();
  });

  it("reconnects when heartbeat acknowledgement times out", async () => {
    vi.useFakeTimers();

    const sockets: MockWebSocket[] = [];
    const disconnectedEvents: { code: number; reason: string }[] = [];

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
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
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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

    const sockets: MockWebSocket[] = [];
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 100,
      heartbeatAckTimeoutMs: 40,
      reconnectMinDelayMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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

    const sockets: MockWebSocket[] = [];
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 30,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 20,
      reconnectMaxDelayMs: 20,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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

    const sockets: MockWebSocket[] = [];
    const disconnected = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 40,
      reconnectMaxDelayMs: 40,
      reconnectJitterRatio: 0,
      hooks: {
        onDisconnected: disconnected,
      },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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

    const sockets: MockWebSocket[] = [];
    const onAuthUpgradeRejected =
      vi.fn<(event: { status: number; immediateRetry: boolean }) => void>();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      connectTimeoutMs: 0,
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 100,
      reconnectJitterRatio: 0,
      hooks: {
        onAuthUpgradeRejected,
      },
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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

    const sockets: MockWebSocket[] = [];

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      reconnectMinDelayMs: 100,
      reconnectMaxDelayMs: 100,
      reconnectJitterRatio: 0,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
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
      openclawBaseUrl: "http://127.0.0.1:18789",
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

  it("queues outbound enqueue frames until connected", async () => {
    const sockets: MockWebSocket[] = [];

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    expect(client.getQueuedOutboundCount()).toBe(0);

    const enqueueFrame = client.enqueueOutbound({
      toAgentDid: createAgentDid(1700000000000),
      payload: { message: "queued message" },
    });

    expect(client.getQueuedOutboundCount()).toBe(1);
    expect(sockets[0].sent).toHaveLength(0);

    sockets[0].open();

    await vi.waitFor(() => {
      expect(client.getQueuedOutboundCount()).toBe(0);
      expect(sockets[0].sent).toHaveLength(1);
    });

    const outbound = parseFrame(sockets[0].sent[0]);
    expect(outbound.type).toBe("enqueue");
    expect(outbound.id).toBe(enqueueFrame.id);

    client.disconnect();
  });
});
