import { parseFrame } from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentRelaySession } from "./agent-relay-session.js";
import {
  createMockSocket,
  createStateHarness,
  RECIPIENT_AGENT_DID,
  SENDER_AGENT_DID,
  withMockWebSocketPair,
} from "./agent-relay-session.test-helpers.js";

describe("AgentRelaySession delivery", () => {
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
  });

  it("evicts stale sockets during alarm heartbeat sweep", async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    vi.setSystemTime(nowMs);

    try {
      const harness = createStateHarness();
      const relaySession = new AgentRelaySession(harness.state, {
        RELAY_RETRY_JITTER_RATIO: "0",
      });
      const staleSocket = createMockSocket();
      const ws = staleSocket as unknown as WebSocket;
      staleSocket.close.mockImplementation(() => {
        harness.connectedSockets.splice(
          harness.connectedSockets.indexOf(ws),
          1,
        );
      });
      harness.connectedSockets.push(ws);

      await relaySession.webSocketMessage(
        ws,
        JSON.stringify({
          v: 1,
          type: "heartbeat_ack",
          id: generateUlid(nowMs + 1),
          ts: new Date(nowMs + 1).toISOString(),
          ackId: generateUlid(nowMs + 2),
        }),
      );

      vi.advanceTimersByTime(60_001);
      await relaySession.alarm();

      expect(staleSocket.close).toHaveBeenCalledWith(
        1011,
        "heartbeat_ack_timeout",
      );
      const outboundHeartbeats = staleSocket.send.mock.calls
        .map((call) => parseFrame(call[0]))
        .filter((frame) => frame.type === "heartbeat");
      expect(outboundHeartbeats).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps superseded sockets inactive even when late frames arrive", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const oldSocket = createMockSocket();
    const oldWs = oldSocket as unknown as WebSocket;
    harness.connectedSockets.push(oldWs);

    const pairClient = createMockSocket();
    const pairServer = createMockSocket();
    const newWs = pairServer as unknown as WebSocket;
    pairServer.send.mockImplementation((payload: unknown) => {
      const frame = parseFrame(payload);
      if (frame.type !== "deliver") {
        return;
      }

      void relaySession.webSocketMessage(
        newWs,
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

    await withMockWebSocketPair(pairClient, pairServer, async () => {
      let connectError: unknown;
      try {
        await relaySession.fetch(
          new Request(`https://relay.example.test${RELAY_CONNECT_PATH}`, {
            method: "GET",
            headers: {
              upgrade: "websocket",
              "x-claw-connector-agent-did": "did:claw:agent:connector",
            },
          }),
        );
      } catch (error) {
        connectError = error;
      }

      if (connectError !== undefined) {
        expect(connectError).toBeInstanceOf(RangeError);
      }
    });

    await relaySession.webSocketMessage(
      oldWs,
      JSON.stringify({
        v: 1,
        type: "heartbeat_ack",
        id: generateUlid(Date.now() + 4),
        ts: new Date().toISOString(),
        ackId: generateUlid(Date.now() + 5),
      }),
    );

    const deliveryState = await Promise.race([
      relaySession
        .deliverToConnector({
          requestId: "req-superseded-socket",
          senderAgentDid: SENDER_AGENT_DID,
          recipientAgentDid: RECIPIENT_AGENT_DID,
          payload: { event: "agent.started" },
        })
        .then((result) => result.state),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 50);
      }),
    ]);

    expect(deliveryState).toBe("delivered");
    expect(oldSocket.send).not.toHaveBeenCalled();
    expect(pairServer.send).toHaveBeenCalled();
  });

  it("does not reject pending deliveries on clean close code 1000", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    const pendingDelivery = relaySession.deliverToConnector({
      requestId: "req-clean-close",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });
    await vi.waitFor(() => {
      expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    });

    harness.connectedSockets.splice(harness.connectedSockets.indexOf(ws), 1);
    await relaySession.webSocketClose(ws, 1000, "normal", true);

    const settleState = await Promise.race([
      pendingDelivery.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 5);
      }),
    ]);
    expect(settleState).toBe("pending");

    await relaySession.webSocketClose(ws, 1011, "unclean", false);
    const queuedAfterUnclean = await pendingDelivery;
    expect(queuedAfterUnclean.state).toBe("queued");
    expect(queuedAfterUnclean.queued).toBe(true);
  });

  it("rejects pending deliveries on unclean close when no sockets remain", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    const pendingDelivery = relaySession.deliverToConnector({
      requestId: "req-unclean-close",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });
    await vi.waitFor(() => {
      expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    });

    harness.connectedSockets.splice(harness.connectedSockets.indexOf(ws), 1);
    await relaySession.webSocketClose(ws, 1011, "socket_error", false);

    const settleState = await Promise.race([
      pendingDelivery.then((result) => result.state),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 20);
      }),
    ]);
    expect(settleState).toBe("queued");
  });
});
