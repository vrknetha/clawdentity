import { parseFrame } from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { AgentRelaySession } from "./agent-relay-session.js";
import {
  createMockSocket,
  createStateHarness,
  RECIPIENT_AGENT_DID,
  RELAY_QUEUE_STORAGE_KEY,
  SENDER_AGENT_DID,
  withMockWebSocketPair,
} from "./agent-relay-session.test-helpers.js";

describe("AgentRelaySession connect", () => {
  it("accepts websocket connects with hibernation state and schedules heartbeat alarm", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);

    const pairClient = createMockSocket();
    const pairServer = createMockSocket();
    await withMockWebSocketPair(pairClient, pairServer, async () => {
      const request = new Request(
        `https://relay.example.test${RELAY_CONNECT_PATH}`,
        {
          method: "GET",
          headers: {
            upgrade: "websocket",
            "x-claw-connector-agent-did":
              "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT9",
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
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT9",
      ]);
      expect(harness.storage.setAlarm.mock.calls.length).toBeGreaterThanOrEqual(
        1,
      );

      // Node's WHATWG Response may reject status 101 in tests; Workers runtime accepts it.
      if (connectResponse !== undefined) {
        expect(connectResponse.status).toBe(101);
      } else {
        expect(connectError).toBeInstanceOf(RangeError);
      }
    });
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

  it("returns websocket upgrade quickly while reconnect drain runs in background", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state, {
      RELAY_RETRY_JITTER_RATIO: "0",
      RELAY_RETRY_INITIAL_MS: "1",
    });

    await relaySession.deliverToConnector({
      requestId: "req-upgrade-fast",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });

    const pairClient = createMockSocket();
    const pairServer = createMockSocket();

    const connectState = await withMockWebSocketPair(
      pairClient,
      pairServer,
      async () => {
        const connectAttempt = relaySession
          .fetch(
            new Request(`https://relay.example.test${RELAY_CONNECT_PATH}`, {
              method: "GET",
              headers: {
                upgrade: "websocket",
                "x-claw-connector-agent-did":
                  "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT9",
              },
            }),
          )
          .then(
            () => "settled" as const,
            () => "settled" as const,
          );

        return Promise.race([
          connectAttempt,
          new Promise<"pending">((resolve) => {
            setTimeout(() => resolve("pending"), 50);
          }),
        ]);
      },
    );

    expect(connectState).toBe("settled");
  });

  it("supersedes an existing socket when a new connector session connects", async () => {
    const harness = createStateHarness();
    const relaySession = new AgentRelaySession(harness.state);
    const oldSocket = createMockSocket();
    const oldWs = oldSocket as unknown as WebSocket;
    oldSocket.close.mockImplementation(() => {
      harness.connectedSockets.splice(
        harness.connectedSockets.indexOf(oldWs),
        1,
      );
    });
    harness.connectedSockets.push(oldWs);

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

    expect(oldSocket.close).toHaveBeenCalledWith(
      1000,
      "superseded_by_new_connection",
    );
    expect(harness.state.acceptWebSocket).toHaveBeenCalledWith(pairServer, [
      "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT9",
    ]);
    expect(oldSocket.close.mock.invocationCallOrder[0]).toBeLessThan(
      harness.state.acceptWebSocket.mock.invocationCallOrder[0],
    );
  });

  it("drains queued messages immediately after connector reconnects", async () => {
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

    const pairClient = createMockSocket();
    const pairServer = createMockSocket();
    const ws = pairServer as unknown as WebSocket;

    pairServer.send.mockImplementation((payload: unknown) => {
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

    await new Promise((resolve) => setTimeout(resolve, 10));

    const sendFrames = pairServer.send.mock.calls
      .map((call) => parseFrame(call[0]))
      .filter((frame) => frame.type === "deliver");
    expect(sendFrames).toHaveLength(1);

    const dedupedResult = await relaySession.deliverToConnector({
      requestId: "req-3",
      senderAgentDid: SENDER_AGENT_DID,
      recipientAgentDid: RECIPIENT_AGENT_DID,
      payload: { event: "agent.started" },
    });
    expect(dedupedResult.state).toBe("delivered");
    expect(dedupedResult.queueDepth).toBe(0);

    const persisted = harness.storageMap.get(RELAY_QUEUE_STORAGE_KEY) as
      | { deliveries: Array<{ requestId: string }> }
      | undefined;
    expect(persisted?.deliveries ?? []).toHaveLength(0);
  });
});
