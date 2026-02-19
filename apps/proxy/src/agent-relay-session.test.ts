import { parseFrame } from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentRelaySession } from "./agent-relay-session.js";

type MockWebSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const SENDER_AGENT_DID = "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
const RECIPIENT_AGENT_DID = "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB8";
const RELAY_QUEUE_STORAGE_KEY = "relay:delivery-queue";

function createMockSocket(): MockWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createStateHarness() {
  const connectedSockets: WebSocket[] = [];
  const storageMap = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async <T>(key: string) => storageMap.get(key) as T | undefined),
    put: vi.fn(async <T>(key: string, value: T) => {
      storageMap.set(key, value);
    }),
    setAlarm: vi.fn(async (_scheduled: number | Date) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };

  const state = {
    acceptWebSocket: vi.fn((socket: WebSocket) => {
      connectedSockets.push(socket);
    }),
    getWebSockets: vi.fn(() => connectedSockets),
    storage,
  };

  return {
    state,
    storage,
    storageMap,
    connectedSockets,
  };
}

describe("AgentRelaySession", () => {
  it("accepts websocket connects with hibernation state and schedules heartbeat alarm", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);

    const originalWebSocketPair = (globalThis as { WebSocketPair?: unknown })
      .WebSocketPair;
    const pairClient = createMockSocket();
    const pairServer = createMockSocket();

    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair =
      class {
        0 = pairClient as unknown as WebSocket;
        1 = pairServer as unknown as WebSocket;
      };

    try {
      const request = new Request(
        `https://relay.example.test${RELAY_CONNECT_PATH}`,
        {
          method: "GET",
          headers: {
            upgrade: "websocket",
            "x-claw-connector-agent-did": "did:claw:agent:connector",
          },
        },
      );

      let connectResponse: Response | undefined;
      let connectError: unknown;
      try {
        connectResponse = await relaySession.fetch(request);
      } catch (error) {
        connectError = error;
      }

      expect(harness.state.acceptWebSocket).toHaveBeenCalledTimes(1);
      expect(harness.state.acceptWebSocket).toHaveBeenCalledWith(pairServer, [
        "did:claw:agent:connector",
      ]);
      expect(harness.storage.setAlarm).toHaveBeenCalledTimes(1);

      // Node's WHATWG Response may reject status 101 in tests; Workers runtime accepts it.
      if (connectResponse !== undefined) {
        expect(connectResponse.status).toBe(101);
      } else {
        expect(connectError).toBeInstanceOf(RangeError);
      }
    } finally {
      if (originalWebSocketPair === undefined) {
        delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
      } else {
        (globalThis as { WebSocketPair?: unknown }).WebSocketPair =
          originalWebSocketPair;
      }
    }
  });

  it("returns 426 for non-websocket connect requests", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);

    const response = await relaySession.fetch(
      new Request(`https://relay.example.test${RELAY_CONNECT_PATH}`, {
        method: "GET",
      }),
    );

    expect(response.status).toBe(426);
    expect(harness.state.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("delivers relay frames to active websocket connectors", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    connectorSocket.send.mockImplementation((payload: unknown) => {
      const frame = parseFrame(payload);
      if (frame.type !== "deliver") {
        return;
      }

      void relaySession.webSocketMessage(
        ws,
        JSON.stringify({
          v: 1,
          type: "deliver_ack",
          id: generateUlid(Date.now() + 1),
          ts: new Date().toISOString(),
          ackId: frame.id,
          accepted: true,
        }),
      );
    });

    const result = await relaySession.deliverToConnector({
      requestId: "req-1",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });

    expect(result.delivered).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.state).toBe("delivered");
    expect(result.queueDepth).toBe(0);
    expect(result.connectedSockets).toBe(1);
    expect(result.deliveryId).toBeTruthy();

    expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    const relayPayload = parseFrame(connectorSocket.send.mock.calls[0]?.[0]);
    expect(relayPayload.type).toBe("deliver");
    if (relayPayload.type === "deliver") {
      expect(relayPayload.fromAgentDid).toBe(SENDER_AGENT_DID);
      expect(relayPayload.toAgentDid).toBe(RECIPIENT_AGENT_DID);
    }
  });

  it("queues relay frames when no connector socket is active", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });

    const result = await relaySession.deliverToConnector({
      requestId: "req-2",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });

    expect(result.delivered).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.state).toBe("queued");
    expect(result.queueDepth).toBe(1);
    expect(result.connectedSockets).toBe(0);

    const persisted = harness.storageMap.get(RELAY_QUEUE_STORAGE_KEY) as {
      deliveries: Array<{ requestId: string }>;
    };
    expect(persisted.deliveries).toHaveLength(1);
    expect(persisted.deliveries[0]?.requestId).toBe("req-2");
  });

  it("drains queued messages after connector reconnects", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
      RELAY_RETRY_INITIAL_MS: "1",
    });

    await relaySession.deliverToConnector({
      requestId: "req-3",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });

    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    connectorSocket.send.mockImplementation((payload: unknown) => {
      const frame = parseFrame(payload);
      if (frame.type !== "deliver") {
        return;
      }

      void relaySession.webSocketMessage(
        ws,
        JSON.stringify({
          v: 1,
          type: "deliver_ack",
          id: generateUlid(Date.now() + 2),
          ts: new Date().toISOString(),
          ackId: frame.id,
          accepted: true,
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await relaySession.alarm();

    const sendFrames = connectorSocket.send.mock.calls
      .map((call) => parseFrame(call[0]))
      .filter((frame) => frame.type === "deliver");
    expect(sendFrames.length).toBe(1);

    const dedupedResult = await relaySession.deliverToConnector({
      requestId: "req-3",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });
    expect(dedupedResult.state).toBe("delivered");
    expect(dedupedResult.queueDepth).toBe(0);
  });

  it("supports fetch RPC delivery endpoint for compatibility", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    connectorSocket.send.mockImplementation((payload: unknown) => {
      const frame = parseFrame(payload);
      if (frame.type !== "deliver") {
        return;
      }

      void relaySession.webSocketMessage(
        ws,
        JSON.stringify({
          v: 1,
          type: "deliver_ack",
          id: generateUlid(Date.now() + 3),
          ts: new Date().toISOString(),
          ackId: frame.id,
          accepted: true,
        }),
      );
    });

    const response = await relaySession.fetch(
      new Request("https://relay.example.test/rpc/deliver-to-connector", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-4",
          senderAgentDid: SENDER_AGENT_DID,
          recipientAgentDid: RECIPIENT_AGENT_DID,
          payload: { event: "agent.started" },
        }),
      }),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      deliveryId: string;
      state: string;
      delivered: boolean;
    };
    expect(body.deliveryId).toBeTruthy();
    expect(body.state).toBe("delivered");
    expect(body.delivered).toBe(true);
  });

  it("returns queue-full error from RPC when buffer is full", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_QUEUE_MAX_MESSAGES_PER_AGENT: "1",
      RELAY_RETRY_JITTER_RATIO: "0",
    });

    const firstResponse = await relaySession.fetch(
      new Request("https://relay.example.test/rpc/deliver-to-connector", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-5",
          senderAgentDid: SENDER_AGENT_DID,
          recipientAgentDid: RECIPIENT_AGENT_DID,
          payload: { event: "agent.started" },
        }),
      }),
    );
    expect(firstResponse.status).toBe(202);

    const secondResponse = await relaySession.fetch(
      new Request("https://relay.example.test/rpc/deliver-to-connector", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "req-6",
          senderAgentDid: SENDER_AGENT_DID,
          recipientAgentDid: RECIPIENT_AGENT_DID,
          payload: { event: "agent.started" },
        }),
      }),
    );

    expect(secondResponse.status).toBe(507);
    const body = (await secondResponse.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("PROXY_RELAY_QUEUE_FULL");
  });
});
