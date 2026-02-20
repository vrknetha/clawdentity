import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { nowIso, nowUtcMs } from "@clawdentity/sdk";
import type { DeliverFrame } from "./frames.js";

const INBOUND_INBOX_DIR_NAME = "inbound-inbox";
const INBOUND_INBOX_INDEX_FILE_NAME = "index.json";
const INBOUND_INBOX_INDEX_LOCK_FILE_NAME = "index.lock";
const INBOUND_INBOX_EVENTS_FILE_NAME = "events.jsonl";
const INBOUND_INBOX_SCHEMA_VERSION = 2;

const DEFAULT_INDEX_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_INDEX_LOCK_STALE_MS = 30_000;
const DEFAULT_INDEX_LOCK_RETRY_MS = 50;

export type ConnectorInboundInboxItem = {
  attemptCount: number;
  conversationId?: string;
  fromAgentDid: string;
  id: string;
  lastAttemptAt?: string;
  lastError?: string;
  nextAttemptAt: string;
  payload: unknown;
  payloadBytes: number;
  receivedAt: string;
  replyTo?: string;
  requestId: string;
  toAgentDid: string;
};

export type ConnectorInboundDeadLetterItem = ConnectorInboundInboxItem & {
  deadLetterReason: string;
  deadLetteredAt: string;
};

type InboundInboxIndexFile = {
  deadLetterByRequestId: Record<string, ConnectorInboundDeadLetterItem>;
  deadLetterBytes: number;
  pendingBytes: number;
  pendingByRequestId: Record<string, ConnectorInboundInboxItem>;
  updatedAt: string;
  version: number;
};

type InboundInboxEvent = {
  details?: Record<string, unknown>;
  requestId?: string;
  type:
    | "inbound_persisted"
    | "inbound_duplicate"
    | "replay_succeeded"
    | "replay_failed"
    | "dead_letter_moved"
    | "dead_letter_replayed"
    | "dead_letter_purged"
    | "inbox_pruned";
};

export type ConnectorInboundInboxPendingSnapshot = {
  nextAttemptAt?: string;
  oldestPendingAt?: string;
  pendingBytes: number;
  pendingCount: number;
};

export type ConnectorInboundInboxDeadLetterSnapshot = {
  deadLetterBytes: number;
  deadLetterCount: number;
  oldestDeadLetterAt?: string;
};

export type ConnectorInboundInboxSnapshot = {
  deadLetter: ConnectorInboundInboxDeadLetterSnapshot;
  pending: ConnectorInboundInboxPendingSnapshot;
};

export type ConnectorInboundInboxEnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  pendingCount: number;
  reason?: string;
};

export type ConnectorInboundInboxMarkFailureResult = {
  movedToDeadLetter: boolean;
};

export type ConnectorInboundInboxOptions = {
  agentName: string;
  configDir: string;
  eventsMaxBytes: number;
  eventsMaxFiles: number;
  maxPendingBytes: number;
  maxPendingMessages: number;
};

type ReleaseLock = () => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePendingItem(
  value: unknown,
): ConnectorInboundInboxItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseOptionalNonEmptyString(value.id) ?? "";
  const requestId = parseOptionalNonEmptyString(value.requestId) ?? "";
  const fromAgentDid = parseOptionalNonEmptyString(value.fromAgentDid) ?? "";
  const toAgentDid = parseOptionalNonEmptyString(value.toAgentDid) ?? "";
  const receivedAt = parseOptionalNonEmptyString(value.receivedAt) ?? "";
  const nextAttemptAt = parseOptionalNonEmptyString(value.nextAttemptAt) ?? "";
  const attemptCount =
    typeof value.attemptCount === "number" &&
    Number.isInteger(value.attemptCount)
      ? value.attemptCount
      : NaN;
  const payloadBytes =
    typeof value.payloadBytes === "number" &&
    Number.isInteger(value.payloadBytes)
      ? value.payloadBytes
      : NaN;

  if (
    id.length === 0 ||
    requestId.length === 0 ||
    fromAgentDid.length === 0 ||
    toAgentDid.length === 0 ||
    receivedAt.length === 0 ||
    nextAttemptAt.length === 0 ||
    !Number.isFinite(attemptCount) ||
    attemptCount < 0 ||
    !Number.isFinite(payloadBytes) ||
    payloadBytes < 0
  ) {
    return undefined;
  }

  return {
    id,
    requestId,
    fromAgentDid,
    toAgentDid,
    payload: value.payload,
    payloadBytes,
    receivedAt,
    nextAttemptAt,
    attemptCount,
    lastError: parseOptionalNonEmptyString(value.lastError),
    lastAttemptAt: parseOptionalNonEmptyString(value.lastAttemptAt),
    conversationId: parseOptionalNonEmptyString(value.conversationId),
    replyTo: parseOptionalNonEmptyString(value.replyTo),
  };
}

function parseDeadLetterItem(
  value: unknown,
): ConnectorInboundDeadLetterItem | undefined {
  const pending = parsePendingItem(value);
  if (!pending) {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const deadLetteredAt =
    parseOptionalNonEmptyString(value.deadLetteredAt) ?? "";
  const deadLetterReason =
    parseOptionalNonEmptyString(value.deadLetterReason) ?? "";
  if (deadLetteredAt.length === 0 || deadLetterReason.length === 0) {
    return undefined;
  }

  return {
    ...pending,
    deadLetteredAt,
    deadLetterReason,
  };
}

function toDefaultIndexFile(): InboundInboxIndexFile {
  return {
    version: INBOUND_INBOX_SCHEMA_VERSION,
    pendingBytes: 0,
    deadLetterBytes: 0,
    pendingByRequestId: {},
    deadLetterByRequestId: {},
    updatedAt: nowIso(),
  };
}

function normalizeIndexFile(raw: unknown): InboundInboxIndexFile {
  if (!isRecord(raw)) {
    throw new Error("Inbound inbox index root must be an object");
  }

  if (raw.version !== INBOUND_INBOX_SCHEMA_VERSION) {
    throw new Error(
      `Inbound inbox index schema version ${String(raw.version)} is unsupported`,
    );
  }

  const pendingByRequestIdRaw = raw.pendingByRequestId;
  const deadLetterByRequestIdRaw = raw.deadLetterByRequestId;
  if (!isRecord(pendingByRequestIdRaw)) {
    throw new Error("Inbound inbox index pendingByRequestId must be an object");
  }
  if (!isRecord(deadLetterByRequestIdRaw)) {
    throw new Error(
      "Inbound inbox index deadLetterByRequestId must be an object",
    );
  }

  const pendingByRequestId: Record<string, ConnectorInboundInboxItem> = {};
  let pendingBytes = 0;
  for (const [requestId, candidate] of Object.entries(pendingByRequestIdRaw)) {
    const entry = parsePendingItem(candidate);
    if (!entry || entry.requestId !== requestId) {
      continue;
    }
    pendingByRequestId[requestId] = entry;
    pendingBytes += entry.payloadBytes;
  }

  const deadLetterByRequestId: Record<string, ConnectorInboundDeadLetterItem> =
    {};
  let deadLetterBytes = 0;
  for (const [requestId, candidate] of Object.entries(
    deadLetterByRequestIdRaw,
  )) {
    const entry = parseDeadLetterItem(candidate);
    if (!entry || entry.requestId !== requestId) {
      continue;
    }
    deadLetterByRequestId[requestId] = entry;
    deadLetterBytes += entry.payloadBytes;
  }

  return {
    version: INBOUND_INBOX_SCHEMA_VERSION,
    pendingByRequestId,
    deadLetterByRequestId,
    pendingBytes,
    deadLetterBytes,
    updatedAt: parseOptionalNonEmptyString(raw.updatedAt) ?? nowIso(),
  };
}

function toComparableTimeMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return Number.MAX_SAFE_INTEGER;
}

export class ConnectorInboundInbox {
  private readonly agentName: string;
  private readonly eventsMaxBytes: number;
  private readonly eventsMaxFiles: number;
  private readonly eventsPath: string;
  private readonly inboxDir: string;
  private readonly indexPath: string;
  private readonly indexLockPath: string;
  private readonly maxPendingBytes: number;
  private readonly maxPendingMessages: number;

  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ConnectorInboundInboxOptions) {
    this.agentName = options.agentName;
    this.inboxDir = join(
      options.configDir,
      "agents",
      this.agentName,
      INBOUND_INBOX_DIR_NAME,
    );
    this.indexPath = join(this.inboxDir, INBOUND_INBOX_INDEX_FILE_NAME);
    this.indexLockPath = join(
      this.inboxDir,
      INBOUND_INBOX_INDEX_LOCK_FILE_NAME,
    );
    this.eventsPath = join(this.inboxDir, INBOUND_INBOX_EVENTS_FILE_NAME);
    this.maxPendingBytes = options.maxPendingBytes;
    this.maxPendingMessages = options.maxPendingMessages;
    this.eventsMaxBytes = Math.max(0, options.eventsMaxBytes);
    this.eventsMaxFiles = Math.max(0, options.eventsMaxFiles);
  }

  async enqueue(
    frame: DeliverFrame,
  ): Promise<ConnectorInboundInboxEnqueueResult> {
    return await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      if (
        index.pendingByRequestId[frame.id] !== undefined ||
        index.deadLetterByRequestId[frame.id] !== undefined
      ) {
        await this.appendEvent({
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
      await this.saveIndex(index);
      await this.appendEvent({
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
    const index = await this.loadIndex();
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
    await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const entry = index.pendingByRequestId[requestId];
      if (entry === undefined) {
        return;
      }

      delete index.pendingByRequestId[requestId];
      index.pendingBytes = Math.max(0, index.pendingBytes - entry.payloadBytes);
      index.updatedAt = nowIso();
      await this.saveIndex(index);
      await this.appendEvent({
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
    return await this.withWriteLock(async () => {
      const index = await this.loadIndex();
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
        await this.saveIndex(index);
        await this.appendEvent({
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
      await this.saveIndex(index);
      await this.appendEvent({
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
    const index = await this.loadIndex();
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
    return await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const requestIds =
        input?.requestIds !== undefined
          ? Array.from(
              new Set(
                input.requestIds
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0),
              ),
            )
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
        await this.appendEvent({
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
        await this.saveIndex(index);
      }

      return { replayedCount };
    });
  }

  async purgeDeadLetter(input?: {
    requestIds?: string[];
  }): Promise<{ purgedCount: number }> {
    return await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const requestIds =
        input?.requestIds !== undefined
          ? Array.from(
              new Set(
                input.requestIds
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0),
              ),
            )
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
        await this.appendEvent({
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
        await this.saveIndex(index);
      }

      return { purgedCount };
    });
  }

  async pruneDelivered(): Promise<void> {
    await this.withWriteLock(async () => {
      const index = await this.loadIndex();
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
      await this.saveIndex(index);
      await this.appendEvent({
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
    const index = await this.loadIndex();
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

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: (() => void) | undefined;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const releaseFileLock = await this.acquireIndexFileLock();
    try {
      return await fn();
    } finally {
      await releaseFileLock();
      release?.();
    }
  }

  private async acquireIndexFileLock(): Promise<ReleaseLock> {
    const startedAt = nowUtcMs();
    await mkdir(this.inboxDir, { recursive: true });

    while (true) {
      try {
        await writeFile(
          this.indexLockPath,
          `${JSON.stringify({ pid: process.pid, createdAt: nowIso() })}\n`,
          {
            encoding: "utf8",
            flag: "wx",
          },
        );

        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            await unlink(this.indexLockPath);
          } catch {
            // ignore
          }
        };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: string }).code
            : undefined;
        if (code !== "EEXIST") {
          throw error;
        }

        const lockStats = await this.readLockStats();
        if (
          lockStats !== undefined &&
          nowUtcMs() - lockStats.mtimeMs > DEFAULT_INDEX_LOCK_STALE_MS
        ) {
          try {
            await unlink(this.indexLockPath);
          } catch {
            // ignore stale lock unlink race
          }
          continue;
        }

        if (nowUtcMs() - startedAt >= DEFAULT_INDEX_LOCK_TIMEOUT_MS) {
          throw new Error("Timed out waiting for inbound inbox index lock");
        }

        await this.sleep(DEFAULT_INDEX_LOCK_RETRY_MS);
      }
    }
  }

  private async readLockStats(): Promise<{ mtimeMs: number } | undefined> {
    try {
      const lockStat = await stat(this.indexLockPath);
      return { mtimeMs: lockStat.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private async loadIndex(): Promise<InboundInboxIndexFile> {
    await mkdir(this.inboxDir, { recursive: true });

    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return toDefaultIndexFile();
      }

      throw error;
    }

    if (raw.trim().length === 0) {
      return toDefaultIndexFile();
    }

    const parsed = JSON.parse(raw) as unknown;
    return normalizeIndexFile(parsed);
  }

  private async saveIndex(index: InboundInboxIndexFile): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });

    const payload = {
      ...index,
      version: INBOUND_INBOX_SCHEMA_VERSION,
      updatedAt: nowIso(),
    } satisfies InboundInboxIndexFile;

    const tmpPath = `${this.indexPath}.tmp-${nowUtcMs()}`;
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.indexPath);
  }

  private async appendEvent(event: InboundInboxEvent): Promise<void> {
    await mkdir(dirname(this.eventsPath), { recursive: true });
    await appendFile(
      this.eventsPath,
      `${JSON.stringify({ ...event, at: nowIso() })}\n`,
      "utf8",
    );
    await this.rotateEventsIfNeeded();
  }

  private async rotateEventsIfNeeded(): Promise<void> {
    if (this.eventsMaxBytes <= 0 || this.eventsMaxFiles <= 0) {
      return;
    }

    let currentSize: number;
    try {
      const current = await stat(this.eventsPath);
      currentSize = current.size;
    } catch {
      return;
    }

    if (currentSize <= this.eventsMaxBytes) {
      return;
    }

    for (let index = this.eventsMaxFiles; index >= 1; index -= 1) {
      const fromPath =
        index === 1 ? this.eventsPath : `${this.eventsPath}.${index - 1}`;
      const toPath = `${this.eventsPath}.${index}`;

      const fromExists = await this.pathExists(fromPath);
      if (!fromExists) {
        continue;
      }

      const toExists = await this.pathExists(toPath);
      if (toExists) {
        await unlink(toPath);
      }

      await rename(fromPath, toPath);
    }

    await writeFile(this.eventsPath, "", "utf8");
  }

  private async pathExists(pathValue: string): Promise<boolean> {
    try {
      await stat(pathValue);
      return true;
    } catch {
      return false;
    }
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
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
