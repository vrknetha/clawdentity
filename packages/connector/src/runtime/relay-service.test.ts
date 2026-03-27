import { randomBytes } from "node:crypto";
import {
  RELAY_DELIVERY_RECEIPT_URL_HEADER,
  RELAY_DELIVERY_RECEIPTS_PATH,
} from "@clawdentity/protocol";
import type { AgentAuthBundle } from "@clawdentity/sdk";
import { describe, expect, it, vi } from "vitest";
import { createRelayService } from "./relay-service.js";

function createAuthBundle(): AgentAuthBundle {
  return {
    accessToken: "access-token",
    accessExpiresAt: "2100-01-01T00:00:00.000Z",
    refreshToken: "refresh-token",
    refreshExpiresAt: "2100-01-01T00:00:00.000Z",
    tokenType: "Bearer",
  };
}

describe("createRelayService", () => {
  it("uses runtime-owned callback URL for outbound and receipt posting", async () => {
    const defaultReceiptCallbackUrl = new URL(
      RELAY_DELIVERY_RECEIPTS_PATH.slice(1),
      "https://proxy.self.example/",
    ).toString();

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const auth = createAuthBundle();

    const relayService = createRelayService({
      agentName: "alpha",
      ait: "test-ait",
      configDir: "/tmp/config",
      defaultReceiptCallbackUrl,
      fetchImpl: fetchMock,
      getCurrentAuth: () => auth,
      registryUrl: "https://registry.example.test",
      secretKey: randomBytes(32),
      setCurrentAuth: async () => {},
      syncAuthFromDisk: async () => {},
    });

    await relayService.relayToPeer({
      peer: "peer",
      peerDid: "did:cdi:registry.example.test:agent:peer",
      peerProxyUrl: "https://peer.example.test/v1/relay/deliver",
      payload: { message: "hello" },
      replyTo: "https://ignored.example.test/v1/relay/delivery-receipts",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, relayInit] = fetchMock.mock.calls[0] ?? [];
    expect(relayInit?.headers).toMatchObject({
      [RELAY_DELIVERY_RECEIPT_URL_HEADER]: defaultReceiptCallbackUrl,
    });

    await relayService.postDeliveryReceipt({
      requestId: "req-1",
      senderAgentDid: "did:cdi:registry.example.test:agent:sender",
      recipientAgentDid: "did:cdi:registry.example.test:agent:recipient",
      status: "processed_by_openclaw",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [receiptUrl] = fetchMock.mock.calls[1] ?? [];
    expect(String(receiptUrl)).toBe(defaultReceiptCallbackUrl);
  });
});
