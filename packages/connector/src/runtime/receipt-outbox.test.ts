import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryReceiptInput } from "./receipt-outbox.js";
import { createDeliveryReceiptOutbox } from "./receipt-outbox.js";
import type { InboundReplayPolicy } from "./types.js";

function createInboundReplayPolicy(): InboundReplayPolicy {
  return {
    batchSize: 10,
    deadLetterNonRetryableMaxAttempts: 3,
    eventsMaxBytes: 1024 * 1024,
    eventsMaxFiles: 10,
    inboxMaxBytes: 1024 * 1024,
    inboxMaxMessages: 100,
    replayIntervalMs: 5,
    retryBackoffFactor: 2,
    retryInitialDelayMs: 5,
    retryMaxDelayMs: 100,
    runtimeReplayMaxAttempts: 5,
    runtimeReplayRetryBackoffFactor: 2,
    runtimeReplayRetryInitialDelayMs: 1,
    runtimeReplayRetryMaxDelayMs: 10,
  };
}

function createReceiptInput(
  overrides: Partial<DeliveryReceiptInput> = {},
): DeliveryReceiptInput {
  return {
    requestId: "req-default",
    senderAgentDid: "did:cdi:test:agent:sender",
    recipientAgentDid: "did:cdi:test:agent:recipient",
    status: "dead_lettered",
    ...overrides,
  };
}

async function waitForCallCount(
  mockFn: { mock: { calls: unknown[][] } },
  expected: number,
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (mockFn.mock.calls.length >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${expected} calls`);
}

describe("delivery receipt outbox", () => {
  it("serializes concurrent enqueue commands and keeps the latest payload for one key", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    const sendReceipt = vi.fn(async (_receipt: unknown) => {});
    const outbox = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });

    await Promise.all([
      outbox.enqueue(
        createReceiptInput({ requestId: "req-concurrent-1", reason: "first" }),
      ),
      outbox.enqueue(
        createReceiptInput({ requestId: "req-concurrent-1", reason: "second" }),
      ),
    ]);

    await outbox.flushDue();

    expect(sendReceipt).toHaveBeenCalledTimes(1);
    expect(sendReceipt.mock.calls[0]?.at(0)).toMatchObject({
      requestId: "req-concurrent-1",
      status: "dead_lettered",
      reason: "second",
    });
  });

  it("serializes concurrent flush commands so one queued receipt is dispatched once", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    let releaseSend: (() => void) | undefined;
    const sendReceipt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSend = resolve;
        }),
    );
    const outbox = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });
    await outbox.enqueue(createReceiptInput({ requestId: "req-concurrent-2" }));

    const firstFlush = outbox.flushDue();
    const secondFlush = outbox.flushDue();

    await waitForCallCount(sendReceipt, 1);
    expect(sendReceipt).toHaveBeenCalledTimes(1);
    releaseSend?.();
    await Promise.all([firstFlush, secondFlush]);

    expect(sendReceipt).toHaveBeenCalledTimes(1);
  });

  it("deduplicates by requestId and status before flush", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    const sendReceipt = vi.fn(async (_receipt: unknown) => {});
    const outbox = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });

    await outbox.enqueue(
      createReceiptInput({ requestId: "req-1", reason: "first" }),
    );
    await outbox.enqueue(
      createReceiptInput({ requestId: "req-1", reason: "second" }),
    );

    await outbox.flushDue();
    expect(sendReceipt).toHaveBeenCalledTimes(1);
    expect(sendReceipt.mock.calls[0]?.at(0)).toMatchObject({
      requestId: "req-1",
      status: "dead_lettered",
      reason: "second",
    });

    // Successful sends must be dequeued idempotently.
    await outbox.flushDue();
    expect(sendReceipt).toHaveBeenCalledTimes(1);
  });

  it("keeps separate outbox entries per status for the same requestId", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    const sendReceipt = vi.fn(async (_receipt: unknown) => {});
    const outbox = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });

    await outbox.enqueue(createReceiptInput({ requestId: "req-2" }));
    await outbox.enqueue(
      createReceiptInput({
        requestId: "req-2",
        status: "processed_by_openclaw",
      }),
    );

    await outbox.flushDue();

    expect(sendReceipt).toHaveBeenCalledTimes(2);
    const sentStatuses = sendReceipt.mock.calls
      .map((call) => call[0] as DeliveryReceiptInput)
      .map((receipt) => receipt.status)
      .sort();
    expect(sentStatuses).toEqual(["dead_lettered", "processed_by_openclaw"]);
  });

  it("retries only after backoff and dequeues after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    vi.useFakeTimers();
    let attempt = 0;
    const sendReceipt = vi.fn(async (_receipt: unknown) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("temporary failure");
      }
    });
    const outbox = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });

    try {
      await outbox.enqueue(
        createReceiptInput({
          requestId: "req-3",
          status: "processed_by_openclaw",
        }),
      );

      await outbox.flushDue();
      expect(sendReceipt).toHaveBeenCalledTimes(1);

      // No retry before retryInitialDelayMs elapses.
      await outbox.flushDue();
      expect(sendReceipt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await outbox.flushDue();
      expect(sendReceipt).toHaveBeenCalledTimes(2);

      // Successful retry dequeues the item idempotently.
      await outbox.flushDue();
      expect(sendReceipt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists queued receipts across outbox recreation", async () => {
    const root = await mkdtemp(join(tmpdir(), "connector-receipt-outbox-"));
    const sendReceipt = vi.fn(async (_receipt: unknown) => {});

    const initial = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });
    await initial.enqueue(
      createReceiptInput({
        requestId: "req-4",
        status: "processed_by_openclaw",
      }),
    );

    const restarted = createDeliveryReceiptOutbox({
      configDir: root,
      agentName: "alpha",
      inboundReplayPolicy: createInboundReplayPolicy(),
      logger: { warn: vi.fn() },
      sendReceipt,
    });
    await restarted.flushDue();

    expect(sendReceipt).toHaveBeenCalledTimes(1);
    expect(sendReceipt.mock.calls[0]?.at(0)).toMatchObject({
      requestId: "req-4",
      status: "processed_by_openclaw",
    });
  });
});
