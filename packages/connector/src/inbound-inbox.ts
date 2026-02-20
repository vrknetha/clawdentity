import { join } from "node:path";
import { nowIso } from "@clawdentity/sdk";
import type { DeliverFrame } from "./frames.js";
import {
  INBOUND_INBOX_DIR_NAME,
  INBOUND_INBOX_EVENTS_FILE_NAME,
  INBOUND_INBOX_INDEX_FILE_NAME,
  INBOUND_INBOX_INDEX_LOCK_FILE_NAME,
} from "./inbound-inbox/constants.js";
import { parseOptionalNonEmptyString } from "./inbound-inbox/schema.js";
import { InboundInboxStorage } from "./inbound-inbox/storage.js";
import type {
  ConnectorInboundDeadLetterItem,
  ConnectorInboundInboxEnqueueResult,
  ConnectorInboundInboxItem,
  ConnectorInboundInboxMarkFailureResult,
  ConnectorInboundInboxOptions,
  ConnectorInboundInboxSnapshot,
} from "./inbound-inbox/types.js";

export type {
  ConnectorInboundDeadLetterItem,
  ConnectorInboundInboxDeadLetterSnapshot,
  ConnectorInboundInboxEnqueueResult,
  ConnectorInboundInboxItem,
  ConnectorInboundInboxMarkFailureResult,
  ConnectorInboundInboxOptions,
  ConnectorInboundInboxPendingSnapshot,
  ConnectorInboundInboxSnapshot,
} from "./inbound-inbox/types.js";

function toComparableTimeMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.MAX_SAFE_INTEGER;
}

function sanitizeRequestIds(requestIds: string[]): string[] {
  return Array.from(
    new Set(
      requestIds.map((item) => item.trim()).filter((item) => item.length > 0),
    ),
  );
}

export class ConnectorInboundInbox {
  private readonly maxPendingBytes: number;
  private readonly maxPendingMessages: number;
  private readonly storage: InboundInboxStorage;

  constructor(options: ConnectorInboundInboxOptions) {
    const inboxDir = resolveConnectorInboundInboxDir({
      configDir: options.configDir,
      agentName: options.agentName,
    });

    this.storage = new InboundInboxStorage({
      inboxDir,
      indexPath: join(inboxDir, INBOUND_INBOX_INDEX_FILE_NAME),
      indexLockPath: join(inboxDir, INBOUND_INBOX_INDEX_LOCK_FILE_NAME),
      eventsPath: join(inboxDir, INBOUND_INBOX_EVENTS_FILE_NAME),
      eventsMaxBytes: Math.max(0, options.eventsMaxBytes),
      eventsMaxFiles: Math.max(0, options.eventsMaxFiles),
    });
    this.maxPendingBytes = options.maxPendingBytes;
    this.maxPendingMessages = options.maxPendingMessages;
  }

  async enqueue(
    frame: DeliverFrame,
  ): Promise<ConnectorInboundInboxEnqueueResult> {
    return await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      if (
        index.pendingByRequestId[frame.id] !== undefined ||
        index.deadLetterByRequestId[frame.id] !== undefined
      ) {
        await this.storage.appendEvent({
          type: "inbound_duplicate",
          requestId: frame.id,
        });
        return {
          accepted: true,
          duplicate: true,
          pendingCount: Object.keys(index.pendingByRequestId).length,
        };
      }

      const payloadBytes = Buffer.byteLength(
        JSON.stringify(frame.payload ?? null),
        "utf8",
      );

      const pendingCount = Object.keys(index.pendingByRequestId).length;
      if (pendingCount >= this.maxPendingMessages) {
        return {
          accepted: false,
          duplicate: false,
          pendingCount,
          reason: "connector inbound inbox is full (message cap reached)",
        };
      }

      if (index.pendingBytes + payloadBytes > this.maxPendingBytes) {
        return {
          accepted: false,
          duplicate: false,
          pendingCount,
          reason: "connector inbound inbox is full (byte cap reached)",
        };
      }

      const pendingItem: ConnectorInboundInboxItem = {
        id: frame.id,
        requestId: frame.id,
        fromAgentDid: frame.fromAgentDid,
        toAgentDid: frame.toAgentDid,
        payload: frame.payload,
        payloadBytes,
        receivedAt: nowIso(),
        nextAttemptAt: nowIso(),
        attemptCount: 0,
        conversationId: parseOptionalNonEmptyString(frame.conversationId),
        replyTo: parseOptionalNonEmptyString(frame.replyTo),
      };

      index.pendingByRequestId[pendingItem.requestId] = pendingItem;
      index.pendingBytes += pendingItem.payloadBytes;
      index.updatedAt = nowIso();
      await this.storage.saveIndex(index);
      await this.storage.appendEvent({
        type: "inbound_persisted",
        requestId: pendingItem.requestId,
        details: {
          payloadBytes,
          fromAgentDid: pendingItem.fromAgentDid,
          toAgentDid: pendingItem.toAgentDid,
          conversationId: pendingItem.conversationId,
          replyTo: pendingItem.replyTo,
        },
      });

      return {
        accepted: true,
        duplicate: false,
        pendingCount: Object.keys(index.pendingByRequestId).length,
      };
    });
  }

  async listDuePending(input: {
    limit: number;
    nowMs: number;
  }): Promise<ConnectorInboundInboxItem[]> {
    const index = await this.storage.loadIndex();
    const due = Object.values(index.pendingByRequestId)
      .filter((item) => toComparableTimeMs(item.nextAttemptAt) <= input.nowMs)
      .sort((left, right) => {
        const leftNext = toComparableTimeMs(left.nextAttemptAt);
        const rightNext = toComparableTimeMs(right.nextAttemptAt);
        if (leftNext !== rightNext) {
          return leftNext - rightNext;
        }

        return (
          toComparableTimeMs(left.receivedAt) -
          toComparableTimeMs(right.receivedAt)
        );
      });

    return due.slice(0, Math.max(1, input.limit));
  }

  async markDelivered(requestId: string): Promise<void> {
    await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      const entry = index.pendingByRequestId[requestId];
      if (entry === undefined) {
        return;
      }

      delete index.pendingByRequestId[requestId];
      index.pendingBytes = Math.max(0, index.pendingBytes - entry.payloadBytes);
      index.updatedAt = nowIso();
      await this.storage.saveIndex(index);
      await this.storage.appendEvent({
        type: "replay_succeeded",
        requestId,
      });
    });
  }

  async markReplayFailure(input: {
    errorMessage: string;
    maxNonRetryableAttempts: number;
    nextAttemptAt: string;
    requestId: string;
    retryable: boolean;
  }): Promise<ConnectorInboundInboxMarkFailureResult> {
    return await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      const entry = index.pendingByRequestId[input.requestId];
      if (entry === undefined) {
        return { movedToDeadLetter: false };
      }

      entry.attemptCount += 1;
      entry.lastError = input.errorMessage;
      entry.lastAttemptAt = nowIso();

      const shouldMoveToDeadLetter =
        !input.retryable &&
        entry.attemptCount >= Math.max(1, input.maxNonRetryableAttempts);

      if (shouldMoveToDeadLetter) {
        const deadLetterEntry: ConnectorInboundDeadLetterItem = {
          ...entry,
          deadLetteredAt: nowIso(),
          deadLetterReason: input.errorMessage,
        };
        delete index.pendingByRequestId[input.requestId];
        index.pendingBytes = Math.max(
          0,
          index.pendingBytes - entry.payloadBytes,
        );
        index.deadLetterByRequestId[input.requestId] = deadLetterEntry;
        index.deadLetterBytes += deadLetterEntry.payloadBytes;
        index.updatedAt = nowIso();
        await this.storage.saveIndex(index);
        await this.storage.appendEvent({
          type: "dead_letter_moved",
          requestId: input.requestId,
          details: {
            attemptCount: deadLetterEntry.attemptCount,
            retryable: input.retryable,
            errorMessage: input.errorMessage,
          },
        });
        return { movedToDeadLetter: true };
      }

      entry.nextAttemptAt = input.nextAttemptAt;
      index.updatedAt = nowIso();
      await this.storage.saveIndex(index);
      await this.storage.appendEvent({
        type: "replay_failed",
        requestId: input.requestId,
        details: {
          attemptCount: entry.attemptCount,
          nextAttemptAt: input.nextAttemptAt,
          retryable: input.retryable,
          errorMessage: input.errorMessage,
        },
      });
      return { movedToDeadLetter: false };
    });
  }

  async listDeadLetter(input?: {
    limit?: number;
  }): Promise<ConnectorInboundDeadLetterItem[]> {
    const index = await this.storage.loadIndex();
    const entries = Object.values(index.deadLetterByRequestId).sort(
      (left, right) => {
        const leftDeadAt = toComparableTimeMs(left.deadLetteredAt);
        const rightDeadAt = toComparableTimeMs(right.deadLetteredAt);
        if (leftDeadAt !== rightDeadAt) {
          return leftDeadAt - rightDeadAt;
        }

        return (
          toComparableTimeMs(left.receivedAt) -
          toComparableTimeMs(right.receivedAt)
        );
      },
    );

    const limit = Math.max(1, input?.limit ?? (entries.length || 1));
    return entries.slice(0, limit);
  }

  async replayDeadLetter(input?: {
    requestIds?: string[];
  }): Promise<{ replayedCount: number }> {
    return await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      const requestIds =
        input?.requestIds !== undefined
          ? sanitizeRequestIds(input.requestIds)
          : Object.keys(index.deadLetterByRequestId);

      let replayedCount = 0;
      for (const requestId of requestIds) {
        if (requestId.length === 0) {
          continue;
        }

        const dead = index.deadLetterByRequestId[requestId];
        if (!dead) {
          continue;
        }

        delete index.deadLetterByRequestId[requestId];
        index.deadLetterBytes = Math.max(
          0,
          index.deadLetterBytes - dead.payloadBytes,
        );

        index.pendingByRequestId[requestId] = {
          ...dead,
          nextAttemptAt: nowIso(),
          lastError: dead.deadLetterReason,
        };
        index.pendingBytes += dead.payloadBytes;
        replayedCount += 1;
        await this.storage.appendEvent({
          type: "dead_letter_replayed",
          requestId,
          details: {
            deadLetteredAt: dead.deadLetteredAt,
            deadLetterReason: dead.deadLetterReason,
          },
        });
      }

      if (replayedCount > 0) {
        index.updatedAt = nowIso();
        await this.storage.saveIndex(index);
      }

      return { replayedCount };
    });
  }

  async purgeDeadLetter(input?: {
    requestIds?: string[];
  }): Promise<{ purgedCount: number }> {
    return await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      const requestIds =
        input?.requestIds !== undefined
          ? sanitizeRequestIds(input.requestIds)
          : Object.keys(index.deadLetterByRequestId);

      let purgedCount = 0;
      for (const requestId of requestIds) {
        if (requestId.length === 0) {
          continue;
        }

        const dead = index.deadLetterByRequestId[requestId];
        if (!dead) {
          continue;
        }

        delete index.deadLetterByRequestId[requestId];
        index.deadLetterBytes = Math.max(
          0,
          index.deadLetterBytes - dead.payloadBytes,
        );
        purgedCount += 1;
        await this.storage.appendEvent({
          type: "dead_letter_purged",
          requestId,
          details: {
            deadLetteredAt: dead.deadLetteredAt,
            deadLetterReason: dead.deadLetterReason,
          },
        });
      }

      if (purgedCount > 0) {
        index.updatedAt = nowIso();
        await this.storage.saveIndex(index);
      }

      return { purgedCount };
    });
  }

  async pruneDelivered(): Promise<void> {
    await this.storage.withWriteLock(async () => {
      const index = await this.storage.loadIndex();
      const beforePendingCount = Object.keys(index.pendingByRequestId).length;
      const beforeDeadLetterCount = Object.keys(
        index.deadLetterByRequestId,
      ).length;
      if (beforePendingCount === 0 && beforeDeadLetterCount === 0) {
        return;
      }

      const nextPending: Record<string, ConnectorInboundInboxItem> = {};
      let pendingBytes = 0;
      for (const [requestId, entry] of Object.entries(
        index.pendingByRequestId,
      )) {
        if (entry.attemptCount < 0) {
          continue;
        }
        nextPending[requestId] = entry;
        pendingBytes += entry.payloadBytes;
      }

      const nextDead: Record<string, ConnectorInboundDeadLetterItem> = {};
      let deadLetterBytes = 0;
      for (const [requestId, entry] of Object.entries(
        index.deadLetterByRequestId,
      )) {
        if (entry.attemptCount < 0) {
          continue;
        }
        nextDead[requestId] = entry;
        deadLetterBytes += entry.payloadBytes;
      }

      index.pendingByRequestId = nextPending;
      index.pendingBytes = pendingBytes;
      index.deadLetterByRequestId = nextDead;
      index.deadLetterBytes = deadLetterBytes;
      index.updatedAt = nowIso();
      await this.storage.saveIndex(index);
      await this.storage.appendEvent({
        type: "inbox_pruned",
        details: {
          beforePendingCount,
          afterPendingCount: Object.keys(nextPending).length,
          beforeDeadLetterCount,
          afterDeadLetterCount: Object.keys(nextDead).length,
        },
      });
    });
  }

  async getSnapshot(): Promise<ConnectorInboundInboxSnapshot> {
    const index = await this.storage.loadIndex();
    const pendingEntries = Object.values(index.pendingByRequestId).sort(
      (left, right) =>
        toComparableTimeMs(left.receivedAt) -
        toComparableTimeMs(right.receivedAt),
    );
    const deadEntries = Object.values(index.deadLetterByRequestId).sort(
      (left, right) =>
        toComparableTimeMs(left.deadLetteredAt) -
        toComparableTimeMs(right.deadLetteredAt),
    );

    const nextAttemptAt = pendingEntries
      .map((entry) => entry.nextAttemptAt)
      .sort(
        (left, right) => toComparableTimeMs(left) - toComparableTimeMs(right),
      )[0];

    return {
      pending: {
        pendingCount: pendingEntries.length,
        pendingBytes: index.pendingBytes,
        oldestPendingAt: pendingEntries[0]?.receivedAt,
        nextAttemptAt,
      },
      deadLetter: {
        deadLetterCount: deadEntries.length,
        deadLetterBytes: index.deadLetterBytes,
        oldestDeadLetterAt: deadEntries[0]?.deadLetteredAt,
      },
    };
  }
}

export function createConnectorInboundInbox(
  options: ConnectorInboundInboxOptions,
): ConnectorInboundInbox {
  return new ConnectorInboundInbox(options);
}

export function resolveConnectorInboundInboxDir(input: {
  agentName: string;
  configDir: string;
}): string {
  return join(
    input.configDir,
    "agents",
    input.agentName,
    INBOUND_INBOX_DIR_NAME,
  );
}
