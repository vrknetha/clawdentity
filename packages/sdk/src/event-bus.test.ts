import { describe, expect, it, vi } from "vitest";
import {
  createEventEnvelope,
  createInMemoryEventBus,
  createQueueEventBus,
} from "./event-bus.js";

describe("event bus", () => {
  it("creates a normalized event envelope", () => {
    const event = createEventEnvelope({
      type: "agent.auth.issued",
      initiatedByAccountId:
        "did:cdi:registry.clawdentity.dev:human:01HF7YAT4TXP6AW5QNXA2Y9K43",
      data: {
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      },
    });

    expect(event.id.length).toBeGreaterThan(0);
    expect(event.version).toBe("v1");
    expect(event.timestampUtc.length).toBeGreaterThan(0);
    expect(event.type).toBe("agent.auth.issued");
    expect(event.initiatedByAccountId).toBe(
      "did:cdi:registry.clawdentity.dev:human:01HF7YAT4TXP6AW5QNXA2Y9K43",
    );
    expect(event.data).toEqual({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
    });
  });

  it("publishes events to in-memory subscribers", async () => {
    const bus = createInMemoryEventBus();
    const subscriber = vi.fn();
    bus.subscribe(subscriber);
    const event = createEventEnvelope({
      type: "agent.auth.refreshed",
      data: {
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      },
    });

    await bus.publish(event);

    expect(bus.publishedEvents).toEqual([event]);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(event);
  });

  it("serializes events when using queue event bus", async () => {
    const queue = {
      send: vi.fn(async (_message: string) => undefined),
    };
    const bus = createQueueEventBus(queue);
    const event = createEventEnvelope({
      type: "agent.auth.revoked",
      data: {
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      },
    });

    await bus.publish(event);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(JSON.stringify(event));
  });
});
