import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliverFrame } from "./frames.js";

const INBOUND_INBOX_DIR_NAME = "inbound-inbox";
const INBOUND_INBOX_INDEX_FILE_NAME = "index.json";
const INBOUND_INBOX_EVENTS_FILE_NAME = "events.jsonl";
const INBOUND_INBOX_SCHEMA_VERSION = 1;

type InboundInboxIndexFile = {
  version: number;
  pendingBytes: number;
  pendingByRequestId: Record<string, ConnectorInboundInboxItem>;
  updatedAt: string;
};

type InboundInboxEvent = {
  details?: Record<string, unknown>;
  requestId?: string;
  type:
    | "inbound_persisted"
    | "inbound_duplicate"
    | "replay_succeeded"
    | "replay_failed"
    | "inbox_pruned";
};

export type ConnectorInboundInboxItem = {
  attemptCount: number;
  fromAgentDid: string;
  id: string;
  lastAttemptAt?: string;
  lastError?: string;
  nextAttemptAt: string;
  payload: unknown;
  payloadBytes: number;
  receivedAt: string;
  requestId: string;
  toAgentDid: string;
};

export type ConnectorInboundInboxSnapshot = {
  nextAttemptAt?: string;
  oldestPendingAt?: string;
  pendingBytes: number;
  pendingCount: number;
};

export type ConnectorInboundInboxEnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  pendingCount: number;
  reason?: string;
};

export type ConnectorInboundInboxOptions = {
  agentName: string;
  configDir: string;
  maxPendingBytes: number;
  maxPendingMessages: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePendingItem(
  value: unknown,
): ConnectorInboundInboxItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const requestId =
    typeof value.requestId === "string" ? value.requestId.trim() : "";
  const fromAgentDid =
    typeof value.fromAgentDid === "string" ? value.fromAgentDid.trim() : "";
  const toAgentDid =
    typeof value.toAgentDid === "string" ? value.toAgentDid.trim() : "";
  const receivedAt =
    typeof value.receivedAt === "string" ? value.receivedAt.trim() : "";
  const nextAttemptAt =
    typeof value.nextAttemptAt === "string" ? value.nextAttemptAt.trim() : "";
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

  const lastError =
    typeof value.lastError === "string" ? value.lastError : undefined;
  const lastAttemptAt =
    typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : undefined;

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
    lastError,
    lastAttemptAt,
  };
}

function toDefaultIndexFile(): InboundInboxIndexFile {
  return {
    version: INBOUND_INBOX_SCHEMA_VERSION,
    pendingBytes: 0,
    pendingByRequestId: {},
    updatedAt: nowIso(),
  };
}

function normalizeIndexFile(raw: unknown): InboundInboxIndexFile {
  if (!isRecord(raw)) {
    throw new Error("Inbound inbox index root must be an object");
  }

  const pendingByRequestIdRaw = raw.pendingByRequestId;
  if (!isRecord(pendingByRequestIdRaw)) {
    throw new Error("Inbound inbox index pendingByRequestId must be an object");
  }

  const pendingByRequestId: Record<string, ConnectorInboundInboxItem> = {};
  let pendingBytes = 0;
  for (const [requestId, candidate] of Object.entries(pendingByRequestIdRaw)) {
    const entry = parsePendingItem(candidate);
    if (entry === undefined || entry.requestId !== requestId) {
      continue;
    }
    pendingByRequestId[requestId] = entry;
    pendingBytes += entry.payloadBytes;
  }

  return {
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version)
        ? raw.version
        : INBOUND_INBOX_SCHEMA_VERSION,
    pendingBytes,
    pendingByRequestId,
    updatedAt:
      typeof raw.updatedAt === "string" && raw.updatedAt.trim().length > 0
        ? raw.updatedAt
        : nowIso(),
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
  private readonly eventsPath: string;
  private readonly indexPath: string;
  private readonly maxPendingBytes: number;
  private readonly maxPendingMessages: number;
  private readonly inboxDir: string;

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
    this.eventsPath = join(this.inboxDir, INBOUND_INBOX_EVENTS_FILE_NAME);
    this.maxPendingBytes = options.maxPendingBytes;
    this.maxPendingMessages = options.maxPendingMessages;
  }

  async enqueue(
    frame: DeliverFrame,
  ): Promise<ConnectorInboundInboxEnqueueResult> {
    return await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const existing = index.pendingByRequestId[frame.id];
      if (existing !== undefined) {
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
    nextAttemptAt: string;
    requestId: string;
  }): Promise<void> {
    await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const entry = index.pendingByRequestId[input.requestId];
      if (entry === undefined) {
        return;
      }

      entry.attemptCount += 1;
      entry.lastError = input.errorMessage;
      entry.lastAttemptAt = nowIso();
      entry.nextAttemptAt = input.nextAttemptAt;
      index.updatedAt = nowIso();
      await this.saveIndex(index);
      await this.appendEvent({
        type: "replay_failed",
        requestId: input.requestId,
        details: {
          attemptCount: entry.attemptCount,
          nextAttemptAt: input.nextAttemptAt,
          errorMessage: input.errorMessage,
        },
      });
    });
  }

  async pruneDelivered(): Promise<void> {
    await this.withWriteLock(async () => {
      const index = await this.loadIndex();
      const beforeCount = Object.keys(index.pendingByRequestId).length;
      if (beforeCount === 0) {
        return;
      }

      const after: Record<string, ConnectorInboundInboxItem> = {};
      let pendingBytes = 0;
      for (const [requestId, entry] of Object.entries(
        index.pendingByRequestId,
      )) {
        if (entry.attemptCount < 0) {
          continue;
        }

        after[requestId] = entry;
        pendingBytes += entry.payloadBytes;
      }

      index.pendingByRequestId = after;
      index.pendingBytes = pendingBytes;
      index.updatedAt = nowIso();
      await this.saveIndex(index);
      await this.appendEvent({
        type: "inbox_pruned",
        details: {
          beforeCount,
          afterCount: Object.keys(after).length,
        },
      });
    });
  }

  async getSnapshot(): Promise<ConnectorInboundInboxSnapshot> {
    const index = await this.loadIndex();
    const entries = Object.values(index.pendingByRequestId);
    if (entries.length === 0) {
      return {
        pendingCount: 0,
        pendingBytes: index.pendingBytes,
      };
    }

    entries.sort((left, right) => {
      return (
        toComparableTimeMs(left.receivedAt) -
        toComparableTimeMs(right.receivedAt)
      );
    });

    const nextAttemptAt = entries
      .map((entry) => entry.nextAttemptAt)
      .sort(
        (left, right) => toComparableTimeMs(left) - toComparableTimeMs(right),
      )[0];

    return {
      pendingCount: entries.length,
      pendingBytes: index.pendingBytes,
      oldestPendingAt: entries[0]?.receivedAt,
      nextAttemptAt,
    };
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: (() => void) | undefined;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release?.();
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

    const tmpPath = `${this.indexPath}.tmp-${Date.now()}`;
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
