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

function createMockSocket(): MockWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createStateHarness() {
  const connectedSockets: WebSocket[] = [];
  const storage = {
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
    const relaySession = new AgentRelaySession(harness.state);
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

    expect(result).toEqual({
      delivered: true,
      connectedSockets: 1,
    });
    expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    const relayPayload = parseFrame(connectorSocket.send.mock.calls[0]?.[0]);
    expect(relayPayload.type).toBe("deliver");
    if (relayPayload.type === "deliver") {
      expect(relayPayload.fromAgentDid).toBe(SENDER_AGENT_DID);
      expect(relayPayload.toAgentDid).toBe(RECIPIENT_AGENT_DID);
    }
    expect(harness.storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("returns not-delivered when no connector socket is active", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);

    const result = await relaySession.deliverToConnector({
      requestId: "req-2",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });

    expect(result).toEqual({
      delivered: false,
      connectedSockets: 0,
    });
    expect(harness.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("sends heartbeat frames on alarm when connectors are active", async () => {
    const harness = createStateHarness();
    const connectorSocket = createMockSocket();
    harness.connectedSockets.push(connectorSocket as unknown as WebSocket);

    const relaySession = new AgentRelaySession(harness.state);
    await relaySession.alarm();

    expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    expect(String(connectorSocket.send.mock.calls[0]?.[0])).toContain(
      '"type":"heartbeat"',
    );
    expect(harness.storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("handles heartbeat websocket frames by replying with heartbeat_ack and refreshing heartbeat", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);
    const connectorSocket = createMockSocket() as unknown as WebSocket;
    const heartbeatId = generateUlid(Date.now() + 2);

    await relaySession.webSocketMessage(
      connectorSocket,
      JSON.stringify({
        v: 1,
        type: "heartbeat",
        id: heartbeatId,
        ts: new Date().toISOString(),
      }),
    );

    expect(
      (connectorSocket as unknown as MockWebSocket).send,
    ).toHaveBeenCalledTimes(1);
    const ackFrame = parseFrame(
      (connectorSocket as unknown as MockWebSocket).send.mock.calls[0]?.[0],
    );
    expect(ackFrame.type).toBe("heartbeat_ack");
    if (ackFrame.type === "heartbeat_ack") {
      expect(ackFrame.ackId).toBe(heartbeatId);
    }
    expect(harness.storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("supports fetch RPC delivery endpoint for compatibility", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);
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
          requestId: "req-3",
          senderAgentDid: SENDER_AGENT_DID,
          recipientAgentDid: RECIPIENT_AGENT_DID,
          payload: { event: "agent.started" },
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(connectorSocket.send).toHaveBeenCalledTimes(1);
  });
});
