import { describe, expect, it, vi } from "vitest";
import { ConnectorClient } from "../client.js";
import { parseFrame } from "../frames.js";
import {
  createAgentDid,
  createMockWebSocketFactory,
  registerConnectorClientTestHooks,
} from "./helpers.js";

registerConnectorClientTestHooks();

describe("ConnectorClient outbound queue", () => {
  it("queues outbound enqueue frames until connected", async () => {
    const { sockets, webSocketFactory } = createMockWebSocketFactory();

    const client = new ConnectorClient({
      connectorUrl: "wss://connector.example.com/agent",
      openclawBaseUrl: "http://127.0.0.1:18789",
      heartbeatIntervalMs: 0,
      webSocketFactory,
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
