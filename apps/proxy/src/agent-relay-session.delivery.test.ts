import { parseFrame } from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentRelaySession } from "./agent-relay-session.js";
import {
  createMockSocket,
  createStateHarness,
  LOCAL_RELAY_ENV,
  RECIPIENT_AGENT_DID,
  SENDER_AGENT_DID,
  withMockWebSocketPair,
} from "./agent-relay-session.test-helpers.js";
import { createInMemoryProxyTrustStore } from "./proxy-trust-store.js";

describe("AgentRelaySession delivery", () => {
  it("pushes receipt frames to active websocket connectors when receipts are recorded", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      ...LOCAL_RELAY_ENV,
      RELAY_RETRY_JITTER_RATIO: "0",
    });
    const connectorSocket = createMockSocket();
    const ws = connectorSocket as unknown as WebSocket;
    harness.connectedSockets.push(ws);

    const receiptRequestId = generateUlid(Date.now());
    await relaySession.recordDeliveryReceipt({
      requestId: receiptRequestId,
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      status: "dead_lettered",
      reason: "hook rejected",
    });

    expect(connectorSocket.send).toHaveBeenCalledTimes(1);
    const frame = parseFrame(connectorSocket.send.mock.calls[0]?.[0]);
    expect(frame.type).toBe("receipt");
    if (frame.type === "receipt") {
      expect(frame.originalFrameId).toBe(receiptRequestId);
      expect(frame.toAgentDid).toBe(RECIPIENT_AGENT_DID);
      expect(frame.status).toBe("dead_lettered");
      expect(frame.reason).toBe("hook rejected");
    }
  });

  it("delivers relay frames to active websocket connectors", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      ...LOCAL_RELAY_ENV,
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
      ...LOCAL_RELAY_ENV,
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

  it("routes enqueue frames from sender sockets to the recipient session", async () => {
    const senderHarness = createStateHarness();
    const recipientHarness = createStateHarness();
    const trustStore = createInMemoryProxyTrustStore();
    await trustStore.upsertPair({
      initiatorAgentDid: SENDER_AGENT_DID,
      responderAgentDid: RECIPIENT_AGENT_DID,
    });

    let senderSession: AgentRelaySession;
    let recipientSession: AgentRelaySession;
    const relayNamespace = {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: (id: DurableObjectId) => {
        const name = id as unknown as string;
        if (name === RECIPIENT_AGENT_DID) {
          return recipientSession;
        }
        if (name === SENDER_AGENT_DID) {
          return senderSession;
        }
        throw new Error(`unexpected relay session id: ${name}`);
      },
    };

    recipientSession = new AgentRelaySession(
      recipientHarness.state,
      { ...LOCAL_RELAY_ENV, RELAY_RETRY_JITTER_RATIO: "0" },
      { trustStore },
    );
    senderSession = new AgentRelaySession(
      senderHarness.state,
      {
        ...LOCAL_RELAY_ENV,
        RELAY_RETRY_JITTER_RATIO: "0",
        AGENT_RELAY_SESSION: relayNamespace,
      },
      {
        relaySessionNamespace: relayNamespace,
        trustStore,
      },
    );

    const recipientConnectorSocket = createMockSocket();
    const recipientWs = recipientConnectorSocket as unknown as WebSocket;
    recipientHarness.connectedSockets.push(recipientWs);
    recipientConnectorSocket.send.mockImplementation((payload: unknown) => {
      const frame = parseFrame(payload);
      if (frame.type !== "deliver") {
        return;
      }

      void recipientSession.webSocketMessage(
        recipientWs,
        JSON.stringify({
          v: 1,
          type: "deliver_ack",
          id: generateUlid(Date.now() + 10),
          ts: new Date().toISOString(),
          ackId: frame.id,
          accepted: true,
        }),
      );
    });

    const senderPairClient = createMockSocket();
    const senderPairServer = createMockSocket();
    const senderWs = senderPairServer as unknown as WebSocket;
    await withMockWebSocketPair(
      senderPairClient,
      senderPairServer,
      async () => {
        let connectError: unknown;
        try {
          await senderSession.fetch(
            new Request(`https://relay.example.test${RELAY_CONNECT_PATH}`, {
              method: "GET",
              headers: {
                upgrade: "websocket",
                "x-claw-connector-agent-did": SENDER_AGENT_DID,
              },
            }),
          );
        } catch (error) {
          connectError = error;
        }

        if (connectError !== undefined) {
          expect(connectError).toBeInstanceOf(RangeError);
        }
      },
    );

    await senderSession.webSocketMessage(
      senderWs,
      JSON.stringify({
        v: 1,
        type: "enqueue",
        id: generateUlid(Date.now() + 20),
        ts: new Date().toISOString(),
        toAgentDid: RECIPIENT_AGENT_DID,
        payload: { message: "hello from sender websocket" },
      }),
    );

    expect(recipientConnectorSocket.send).toHaveBeenCalled();
    const deliveredFrame = parseFrame(
      recipientConnectorSocket.send.mock.calls[0]?.[0],
    );
    expect(deliveredFrame.type).toBe("deliver");
    if (deliveredFrame.type === "deliver") {
      expect(deliveredFrame.fromAgentDid).toBe(SENDER_AGENT_DID);
      expect(deliveredFrame.toAgentDid).toBe(RECIPIENT_AGENT_DID);
      expect(deliveredFrame.payload).toEqual({
        message: "hello from sender websocket",
      });
    }

    const senderAckFrame = parseFrame(senderPairServer.send.mock.calls[0]?.[0]);
    expect(senderAckFrame.type).toBe("enqueue_ack");
    if (senderAckFrame.type === "enqueue_ack") {
      expect(senderAckFrame.ackId).toBeTruthy();
      expect(senderAckFrame.accepted).toBe(true);
    }
  });

  it("drains stored receipt frames to connector on reconnect", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      ...LOCAL_RELAY_ENV,
      RELAY_RETRY_JITTER_RATIO: "0",
    });

    const receiptRequestId = generateUlid(Date.now());
    await relaySession.recordDeliveryReceipt({
      requestId: receiptRequestId,
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      status: "delivered_to_webhook",
    });

    const pairClient = createMockSocket();
    const pairServer = createMockSocket();
    await withMockWebSocketPair(pairClient, pairServer, async () => {
      let connectError: unknown;
      try {
        await relaySession.fetch(
          new Request(`https://relay.example.test${RELAY_CONNECT_PATH}`, {
            method: "GET",
            headers: {
              upgrade: "websocket",
              "x-claw-connector-agent-did": RECIPIENT_AGENT_DID,
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

    expect(pairServer.send).toHaveBeenCalled();
    const sentFrames = pairServer.send.mock.calls.map((call) =>
      parseFrame(call[0]),
    );
    const receiptFrame = sentFrames.find((frame) => frame.type === "receipt");
    expect(receiptFrame?.type).toBe("receipt");
    if (receiptFrame?.type === "receipt") {
      expect(receiptFrame.originalFrameId).toBe(receiptRequestId);
      expect(receiptFrame.status).toBe("delivered_to_webhook");
      expect(receiptFrame.toAgentDid).toBe(RECIPIENT_AGENT_DID);
    }
  });

  it("evicts stale sockets during alarm heartbeat sweep", async () => {
    vi.useFakeTimers();
    const nowMs = Date.now();
    vi.setSystemTime(nowMs);

    try {
      const harness = createStateHarness();
      const relaySession = new AgentRelaySession(harness.state, {
        ...LOCAL_RELAY_ENV,
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
      ...LOCAL_RELAY_ENV,
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
              "x-claw-connector-agent-did":
                "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT9",
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
      ...LOCAL_RELAY_ENV,
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
      ...LOCAL_RELAY_ENV,
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
