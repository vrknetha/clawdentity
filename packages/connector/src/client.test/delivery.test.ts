import { generateUlid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { ConnectorClient } from "../client.js";
import { parseFrame, serializeFrame } from "../frames.js";
import {
  createAgentDid,
  createMockWebSocketFactory,
  registerConnectorClientTestHooks,
} from "./helpers.js";

registerConnectorClientTestHooks();

describe("ConnectorClient delivery and heartbeat frames", () => {
  it("acks inbound heartbeat frames", async () => {
    const { sockets, webSocketFactory } = createMockWebSocketFactory();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      webSocketFactory,
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
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      openclawHookToken: "hook-secret",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      webSocketFactory,
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
      "x-clawdentity-agent-did": expect.stringMatching(
        /^did:cdi:registry.clawdentity.com:agent:/,
      ),
      "x-clawdentity-to-agent-did": expect.stringMatching(
        /^did:cdi:registry.clawdentity.com:agent:/,
      ),
      "x-clawdentity-verified": "true",
      "x-openclaw-token": "hook-secret",
      "x-request-id": deliverId,
    });
    expect(
      (requestInit?.headers as Record<string, string>)[
        "x-clawdentity-agent-name"
      ],
    ).toBeUndefined();
    expect(
      (requestInit?.headers as Record<string, string>)[
        "x-clawdentity-human-name"
      ],
    ).toBeUndefined();

    const ack = parseFrame(sockets[0].sent[sockets[0].sent.length - 1]);
    expect(ack.type).toBe("deliver_ack");
    if (ack.type !== "deliver_ack") {
      throw new Error("expected deliver_ack frame");
    }
    expect(ack.ackId).toBe(deliverId);
    expect(ack.accepted).toBe(true);

    client.disconnect();
  });

  it("adds sender profile headers when resolver returns peer profile", async () => {
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      resolveInboundSenderProfile: async () => ({
        agentName: "ravi-assistant",
        humanName: "Ravi Kiran",
      }),
      webSocketFactory,
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

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit?.headers).toMatchObject({
      "x-clawdentity-agent-name": "ravi-assistant",
      "x-clawdentity-human-name": "Ravi Kiran",
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
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad", { status: 400 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      webSocketFactory,
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
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const fetchMock = vi.fn<typeof fetch>();
    const inboundDeliverHandler = vi.fn(async () => ({ accepted: true }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      inboundDeliverHandler,
      webSocketFactory,
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
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
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
      webSocketFactory,
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

  it("retries when local openclaw hook auth rejects with 401", async () => {
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      fetchImpl: fetchMock,
      openclawDeliverTimeoutMs: 100,
      openclawDeliverRetryInitialDelayMs: 1,
      openclawDeliverRetryMaxDelayMs: 2,
      openclawDeliverRetryBudgetMs: 500,
      webSocketFactory,
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
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("routes inbound receipt frames to receipt hooks", async () => {
    const { sockets, webSocketFactory } = createMockWebSocketFactory();
    const onReceipt = vi.fn();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      hooks: {
        onReceipt,
      },
      webSocketFactory,
    });

    client.connect();
    sockets[0].open();

    const receiptId = generateUlid(1700000000000);
    const originalFrameId = generateUlid(1700000000100);
    sockets[0].message(
      serializeFrame({
        v: 1,
        type: "receipt",
        id: receiptId,
        ts: "2026-01-01T00:00:00.000Z",
        originalFrameId,
        toAgentDid: createAgentDid(1700000000200),
        status: "processed_by_openclaw",
      }),
    );

    await vi.waitFor(() => {
      expect(onReceipt).toHaveBeenCalledTimes(1);
    });
    expect(sockets[0].sent).toHaveLength(0);
    expect(onReceipt.mock.calls[0]?.[0]).toMatchObject({
      type: "receipt",
      id: receiptId,
      originalFrameId,
      status: "processed_by_openclaw",
    });

    client.disconnect();
  });
});
