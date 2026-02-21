import { parseFrame } from "@clawdentity/connector";
import { generateUlid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { AgentRelaySession } from "./agent-relay-session.js";
import {
  createMockSocket,
  createStateHarness,
  RECIPIENT_AGENT_DID,
  SENDER_AGENT_DID,
} from "./agent-relay-session.test-helpers.js";

describe("AgentRelaySession RPC", () => {
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
