import { describe, expect, it, vi } from "vitest";
import {
  DELIVERY_RECEIPT_EVENT_TYPE,
  handleReceiptQueueEvent,
  parseReceiptQueueEvent,
} from "./receipt-events.js";

describe("receipt queue events", () => {
  it("parses valid delivery receipt events", () => {
    const event = parseReceiptQueueEvent({
      type: DELIVERY_RECEIPT_EVENT_TYPE,
      requestId: "req-1",
      senderAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      recipientAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      status: "processed_by_openclaw",
    });

    expect(event.type).toBe("delivery_receipt");
    expect(event.status).toBe("processed_by_openclaw");
  });

  it("rejects invalid delivery receipt status", () => {
    expect(() =>
      parseReceiptQueueEvent({
        type: DELIVERY_RECEIPT_EVENT_TYPE,
        requestId: "req-2",
        senderAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        recipientAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        status: "delivered",
      }),
    ).toThrow("Unsupported receipt queue status");
  });

  it("routes queue receipt events to sender relay durable object", async () => {
    const fetchSpy = vi.fn(async (_request: Request) =>
      Response.json({ accepted: true }, { status: 202 }),
    );
    const relaySessionNamespace = {
      idFromName: vi.fn((name: string) => name as unknown as DurableObjectId),
      get: vi.fn(() => ({
        fetch: fetchSpy,
      })),
    };

    await handleReceiptQueueEvent({
      event: parseReceiptQueueEvent({
        type: DELIVERY_RECEIPT_EVENT_TYPE,
        requestId: "req-3",
        senderAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        recipientAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        status: "dead_lettered",
        reason: "hook failed",
      }),
      relaySessionNamespace,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/rpc/record-delivery-receipt");
    const payload = (await request.json()) as {
      requestId?: string;
      status?: string;
      reason?: string;
    };
    expect(payload).toMatchObject({
      requestId: "req-3",
      status: "dead_lettered",
      reason: "hook failed",
    });
  });
});
