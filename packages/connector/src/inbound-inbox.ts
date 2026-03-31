import { join } from "node:path";
import { nowIso } from "@clawdentity/sdk";
import type { DeliverFrame } from "./frames.js";
import {
  INBOUND_INBOX_DB_FILE_NAME,
  INBOUND_INBOX_DIR_NAME,
} from "./inbound-inbox/constants.js";
import { parseOptionalNonEmptyString } from "./inbound-inbox/parse.js";
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

function sanitizeRequestIds(requestIds: string[]): string[] {
  return Array.from(
    new Set(
      requestIds.map((item) => item.trim()).filter((item) => item.length > 0),
    ),
  );
}

function buildPendingItem(frame: DeliverFrame): ConnectorInboundInboxItem {
  const receivedAt = nowIso();
  return {
    id: frame.id,
    requestId: frame.id,
    fromAgentDid: frame.fromAgentDid,
    toAgentDid: frame.toAgentDid,
    groupId: parseOptionalNonEmptyString(frame.groupId),
    payload: frame.payload,
    payloadBytes: Buffer.byteLength(
      JSON.stringify(frame.payload ?? null),
      "utf8",
    ),
    receivedAt,
    nextAttemptAt: receivedAt,
    attemptCount: 0,
    conversationId: parseOptionalNonEmptyString(frame.conversationId),
    replyTo: parseOptionalNonEmptyString(frame.replyTo),
  };
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
      dbPath: join(inboxDir, INBOUND_INBOX_DB_FILE_NAME),
      eventsMaxRows: Math.max(1, options.eventsMaxRows),
    });
    this.maxPendingBytes = options.maxPendingBytes;
    this.maxPendingMessages = options.maxPendingMessages;
  }

  async enqueue(
    frame: DeliverFrame,
  ): Promise<ConnectorInboundInboxEnqueueResult> {
    return await this.storage.withWriteLock(async () => {
      return this.storage.runInTransaction((transaction) => {
        if (transaction.hasRequest(frame.id)) {
          const totals = transaction.getPendingTotals();
          transaction.appendEvent({
            type: "inbound_duplicate",
            requestId: frame.id,
          });
          return {
            accepted: true,
            duplicate: true,
            pendingCount: totals.pendingCount,
          };
        }

        const pendingItem = buildPendingItem(frame);
        const totals = transaction.getPendingTotals();
        if (totals.pendingCount >= this.maxPendingMessages) {
          return {
            accepted: false,
            duplicate: false,
            pendingCount: totals.pendingCount,
            reason: "connector inbound inbox is full (message cap reached)",
          };
        }

        if (
          totals.pendingBytes + pendingItem.payloadBytes >
          this.maxPendingBytes
        ) {
          return {
            accepted: false,
            duplicate: false,
            pendingCount: totals.pendingCount,
            reason: "connector inbound inbox is full (byte cap reached)",
          };
        }

        transaction.insertPending(pendingItem);
        transaction.appendEvent({
          type: "inbound_persisted",
          requestId: pendingItem.requestId,
          details: {
            payloadBytes: pendingItem.payloadBytes,
            fromAgentDid: pendingItem.fromAgentDid,
            toAgentDid: pendingItem.toAgentDid,
            groupId: pendingItem.groupId,
            conversationId: pendingItem.conversationId,
            replyTo: pendingItem.replyTo,
          },
        });

        return {
          accepted: true,
          duplicate: false,
          pendingCount: totals.pendingCount + 1,
        };
      });
    });
  }

  async listDuePending(input: {
    limit: number;
    nowMs: number;
  }): Promise<ConnectorInboundInboxItem[]> {
    return await this.storage.listDuePending(input);
  }

  async markDelivered(requestId: string): Promise<void> {
    await this.storage.withWriteLock(async () => {
      this.storage.runInTransaction((transaction) => {
        if (!transaction.deletePending(requestId)) {
          return;
        }
        transaction.appendEvent({
          type: "replay_succeeded",
          requestId,
        });
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
      return this.storage.runInTransaction((transaction) => {
        const entry = transaction.getPending(input.requestId);
        if (entry === undefined) {
          return { movedToDeadLetter: false };
        }

        const updatedEntry: ConnectorInboundInboxItem = {
          ...entry,
          attemptCount: entry.attemptCount + 1,
          lastError: input.errorMessage,
          lastAttemptAt: nowIso(),
        };

        const shouldMoveToDeadLetter =
          !input.retryable &&
          updatedEntry.attemptCount >=
            Math.max(1, input.maxNonRetryableAttempts);

        if (shouldMoveToDeadLetter) {
          const deadLetterEntry: ConnectorInboundDeadLetterItem = {
            ...updatedEntry,
            deadLetteredAt: nowIso(),
            deadLetterReason: input.errorMessage,
          };
          transaction.deletePending(input.requestId);
          transaction.insertDeadLetter(deadLetterEntry);
          transaction.appendEvent({
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

        transaction.updatePending({
          ...updatedEntry,
          nextAttemptAt: input.nextAttemptAt,
        });
        transaction.appendEvent({
          type: "replay_failed",
          requestId: input.requestId,
          details: {
            attemptCount: updatedEntry.attemptCount,
            nextAttemptAt: input.nextAttemptAt,
            retryable: input.retryable,
            errorMessage: input.errorMessage,
          },
        });
        return { movedToDeadLetter: false };
      });
    });
  }

  async listDeadLetter(input?: {
    limit?: number;
  }): Promise<ConnectorInboundDeadLetterItem[]> {
    return await this.storage.listDeadLetter(input);
  }

  async replayDeadLetter(input?: {
    requestIds?: string[];
  }): Promise<{ replayedCount: number }> {
    return await this.storage.withWriteLock(async () => {
      return this.storage.runInTransaction((transaction) => {
        const requestIds =
          input?.requestIds !== undefined
            ? sanitizeRequestIds(input.requestIds)
            : transaction.getDeadLetterRequestIds();

        let replayedCount = 0;
        for (const requestId of requestIds) {
          const dead = transaction.getDeadLetter(requestId);
          if (!dead) {
            continue;
          }

          transaction.deleteDeadLetter(requestId);
          transaction.insertPending({
            ...dead,
            nextAttemptAt: nowIso(),
            lastError: dead.deadLetterReason,
          });
          replayedCount += 1;
          transaction.appendEvent({
            type: "dead_letter_replayed",
            requestId,
            details: {
              deadLetteredAt: dead.deadLetteredAt,
              deadLetterReason: dead.deadLetterReason,
            },
          });
        }

        return { replayedCount };
      });
    });
  }

  async purgeDeadLetter(input?: {
    requestIds?: string[];
  }): Promise<{ purgedCount: number }> {
    return await this.storage.withWriteLock(async () => {
      return this.storage.runInTransaction((transaction) => {
        const requestIds =
          input?.requestIds !== undefined
            ? sanitizeRequestIds(input.requestIds)
            : transaction.getDeadLetterRequestIds();

        let purgedCount = 0;
        for (const requestId of requestIds) {
          const dead = transaction.getDeadLetter(requestId);
          if (!dead) {
            continue;
          }

          transaction.deleteDeadLetter(requestId);
          purgedCount += 1;
          transaction.appendEvent({
            type: "dead_letter_purged",
            requestId,
            details: {
              deadLetteredAt: dead.deadLetteredAt,
              deadLetterReason: dead.deadLetterReason,
            },
          });
        }

        return { purgedCount };
      });
    });
  }

  async pruneDelivered(): Promise<void> {
    // SQLite mode removes delivered rows immediately (deletePending/deleteDeadLetter),
    // so there is nothing stale to prune during startup reconciliation.
    return;
  }

  async getSnapshot(): Promise<ConnectorInboundInboxSnapshot> {
    return await this.storage.getSnapshot();
  }

  async close(): Promise<void> {
    await this.storage.close();
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
