import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowUtcMs } from "@clawdentity/sdk";
import {
  AGENTS_DIR_NAME,
  RECEIPT_OUTBOX_DIR_NAME,
  RECEIPT_OUTBOX_FILENAME,
} from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";
import { computeRuntimeReplayRetryDelayMs } from "./policy.js";
import type { InboundReplayPolicy } from "./types.js";

export type DeliveryReceiptOutboxItem = {
  createdAtMs: number;
  key: string;
  nextAttemptAtMs: number;
  reason?: string;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
  status: "processed_by_openclaw" | "dead_lettered";
  attemptCount: number;
};

export type DeliveryReceiptInput = {
  reason?: string;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
  status: "processed_by_openclaw" | "dead_lettered";
};

function resolveReceiptOutboxPath(input: {
  agentName: string;
  configDir: string;
}): string {
  return join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    RECEIPT_OUTBOX_DIR_NAME,
    RECEIPT_OUTBOX_FILENAME,
  );
}

function makeReceiptOutboxKey(input: DeliveryReceiptInput): string {
  return `${input.requestId}:${input.status}`;
}

function isOutboxItem(
  candidate: unknown,
): candidate is DeliveryReceiptOutboxItem {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const value = candidate as Partial<DeliveryReceiptOutboxItem>;
  return (
    typeof value.key === "string" &&
    typeof value.requestId === "string" &&
    typeof value.senderAgentDid === "string" &&
    typeof value.recipientAgentDid === "string" &&
    (value.status === "processed_by_openclaw" ||
      value.status === "dead_lettered") &&
    typeof value.createdAtMs === "number" &&
    Number.isFinite(value.createdAtMs) &&
    typeof value.nextAttemptAtMs === "number" &&
    Number.isFinite(value.nextAttemptAtMs) &&
    typeof value.attemptCount === "number" &&
    Number.isInteger(value.attemptCount) &&
    value.attemptCount >= 0 &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function createDeliveryReceiptOutbox(input: {
  agentName: string;
  configDir: string;
  inboundReplayPolicy: InboundReplayPolicy;
  logger: {
    warn: (event: string, payload?: Record<string, unknown>) => void;
  };
  sendReceipt: (receipt: DeliveryReceiptInput) => Promise<void>;
}): {
  enqueue: (receipt: DeliveryReceiptInput) => Promise<void>;
  flushDue: () => Promise<void>;
} {
  const outboxPath = resolveReceiptOutboxPath({
    configDir: input.configDir,
    agentName: input.agentName,
  });

  let inFlight: Promise<void> | undefined;

  const withLock = async (fn: () => Promise<void>): Promise<void> => {
    while (inFlight !== undefined) {
      try {
        await inFlight;
      } catch {
        // Previous operation error should not permanently block the queue lock.
      }
    }
    const next = fn().finally(() => {
      inFlight = undefined;
    });
    inFlight = next;
    await next;
  };

  const load = async (): Promise<DeliveryReceiptOutboxItem[]> => {
    let raw: string;
    try {
      raw = await readFile(outboxPath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }

      input.logger.warn("connector.receipt_outbox.read_failed", {
        outboxPath,
        reason: sanitizeErrorReason(error),
      });
      return [];
    }

    if (raw.trim().length === 0) {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      input.logger.warn("connector.receipt_outbox.invalid_json", {
        outboxPath,
        reason: sanitizeErrorReason(error),
      });
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isOutboxItem);
  };

  const save = async (items: DeliveryReceiptOutboxItem[]): Promise<void> => {
    await mkdir(dirname(outboxPath), { recursive: true });
    const tmpPath = `${outboxPath}.tmp-${nowUtcMs()}-${Math.random().toString(16).slice(2)}`;
    await writeFile(tmpPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    await rename(tmpPath, outboxPath);
  };

  const enqueue = async (receipt: DeliveryReceiptInput): Promise<void> => {
    await withLock(async () => {
      const nowMs = nowUtcMs();
      const items = await load();
      const key = makeReceiptOutboxKey(receipt);
      const existingIndex = items.findIndex((item) => item.key === key);
      const next: DeliveryReceiptOutboxItem = {
        key,
        createdAtMs: nowMs,
        nextAttemptAtMs: nowMs,
        requestId: receipt.requestId,
        senderAgentDid: receipt.senderAgentDid,
        recipientAgentDid: receipt.recipientAgentDid,
        status: receipt.status,
        reason: receipt.reason,
        attemptCount: 0,
      };
      if (existingIndex >= 0) {
        items[existingIndex] = {
          ...items[existingIndex],
          ...next,
          createdAtMs: items[existingIndex]?.createdAtMs ?? nowMs,
        };
      } else {
        items.push(next);
      }
      await save(items);
    });
  };

  const flushDue = async (): Promise<void> => {
    await withLock(async () => {
      const nowMs = nowUtcMs();
      const items = await load();
      if (items.length === 0) {
        return;
      }

      const deduped = new Map<string, DeliveryReceiptOutboxItem>();
      for (const item of items) {
        deduped.set(item.key, item);
      }
      const pending = Array.from(deduped.values()).sort(
        (a, b) => a.createdAtMs - b.createdAtMs,
      );
      const retained = new Map<string, DeliveryReceiptOutboxItem>();

      for (const item of pending) {
        if (item.nextAttemptAtMs > nowMs) {
          retained.set(item.key, item);
          continue;
        }

        try {
          await input.sendReceipt({
            requestId: item.requestId,
            senderAgentDid: item.senderAgentDid,
            recipientAgentDid: item.recipientAgentDid,
            status: item.status,
            reason: item.reason,
          });
        } catch (error) {
          const attemptCount = item.attemptCount + 1;
          retained.set(item.key, {
            ...item,
            attemptCount,
            nextAttemptAtMs:
              nowMs +
              computeRuntimeReplayRetryDelayMs({
                attemptCount,
                policy: input.inboundReplayPolicy,
              }),
          });
          input.logger.warn("connector.receipt_outbox.retry_scheduled", {
            requestId: item.requestId,
            status: item.status,
            attemptCount,
            reason: sanitizeErrorReason(error),
          });
        }
      }

      await save(
        Array.from(retained.values()).sort(
          (a, b) => a.createdAtMs - b.createdAtMs,
        ),
      );
    });
  };

  return {
    enqueue,
    flushDue,
  };
}
