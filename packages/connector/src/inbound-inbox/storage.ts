import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "@clawdentity/sdk";
import {
  toDeadLetterItem,
  toDeadLetterRow,
  toEventRow,
  toPendingItem,
  toPendingRow,
} from "./records.js";
import type {
  ConnectorInboundDeadLetterItem,
  ConnectorInboundInboxItem,
  ConnectorInboundInboxSnapshot,
  InboundInboxEvent,
} from "./types.js";

type InboundInboxStorageOptions = {
  busyTimeoutMs?: number;
  dbPath: string;
  eventsMaxRows: number;
  inboxDir: string;
};

type CountBytesRow = {
  bytes: number | null;
  count: number | null;
};

type PendingSnapshotRow = CountBytesRow & {
  next_attempt_at: string | null;
  oldest_pending_at: string | null;
};

type DeadLetterSnapshotRow = CountBytesRow & {
  oldest_dead_letter_at: string | null;
};

type RequestIdRow = {
  request_id: string;
};

export type InboundInboxWriteTransaction = {
  appendEvent: (event: InboundInboxEvent) => void;
  deleteDeadLetter: (requestId: string) => boolean;
  deletePending: (requestId: string) => boolean;
  getDeadLetter: (
    requestId: string,
  ) => ConnectorInboundDeadLetterItem | undefined;
  getDeadLetterRequestIds: () => string[];
  getPending: (requestId: string) => ConnectorInboundInboxItem | undefined;
  getPendingTotals: () => { pendingBytes: number; pendingCount: number };
  getPruneCounts: () => {
    afterDeadLetterCount: number;
    afterPendingCount: number;
    beforeDeadLetterCount: number;
    beforePendingCount: number;
  };
  hasRequest: (requestId: string) => boolean;
  insertDeadLetter: (item: ConnectorInboundDeadLetterItem) => void;
  insertPending: (item: ConnectorInboundInboxItem) => void;
  updatePending: (item: ConnectorInboundInboxItem) => void;
};

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

function toSafeCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

function normalizeBusyTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  }

  return Math.max(1, Math.floor(value));
}

function isRecoverableSqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("file is not a database") ||
    message.includes("database disk image is malformed") ||
    message.includes("malformed")
  );
}

function safeClose(database: DatabaseSync | undefined): void {
  if (database === undefined) {
    return;
  }

  try {
    database.close();
  } catch {
    // ignore close failures during recovery
  }
}

function configureConnection(
  database: DatabaseSync,
  busyTimeoutMs: number,
): void {
  database.exec(`
    PRAGMA busy_timeout = ${busyTimeoutMs};
    PRAGMA foreign_keys = ON;
  `);
}

function openDatabase(path: string, busyTimeoutMs: number): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    configureConnection(database, busyTimeoutMs);
    database.prepare("PRAGMA schema_version").get();
    return database;
  } catch (error) {
    safeClose(database);
    if (!isRecoverableSqliteError(error)) {
      throw error;
    }

    rmSync(path, { force: true });
    database = new DatabaseSync(path);
    configureConnection(database, busyTimeoutMs);
    return database;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS inbox_pending (
      request_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      from_agent_did TEXT NOT NULL,
      to_agent_did TEXT NOT NULL,
      conversation_id TEXT,
      reply_to TEXT,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS inbox_dead_letter (
      request_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      from_agent_did TEXT NOT NULL,
      to_agent_did TEXT NOT NULL,
      conversation_id TEXT,
      reply_to TEXT,
      payload TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_attempt_at TEXT,
      last_error TEXT,
      dead_lettered_at TEXT NOT NULL,
      dead_letter_reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      request_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_inbox_pending_next_attempt
      ON inbox_pending(next_attempt_at, received_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_dead_letter_order
      ON inbox_dead_letter(dead_lettered_at, received_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_events_created_at
      ON inbox_events(created_at);
  `);
}

function openAndConfigureDatabase(
  path: string,
  busyTimeoutMs: number,
): DatabaseSync {
  let database = openDatabase(path, busyTimeoutMs);
  try {
    configureDatabase(database);
    return database;
  } catch (error) {
    safeClose(database);
    if (!isRecoverableSqliteError(error)) {
      throw error;
    }

    rmSync(path, { force: true });
    database = new DatabaseSync(path);
    configureConnection(database, busyTimeoutMs);
    configureDatabase(database);
    return database;
  }
}

export class InboundInboxStorage {
  private readonly database: DatabaseSync;
  private readonly eventsMaxRows: number;

  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: InboundInboxStorageOptions) {
    mkdirSync(options.inboxDir, { recursive: true });
    mkdirSync(dirname(options.dbPath), { recursive: true });

    this.eventsMaxRows = Math.max(1, options.eventsMaxRows);
    this.database = openAndConfigureDatabase(
      options.dbPath,
      normalizeBusyTimeoutMs(options.busyTimeoutMs),
    );
  }

  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
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

  async listDuePending(input: {
    limit: number;
    nowMs: number;
  }): Promise<ConnectorInboundInboxItem[]> {
    const nowAt = new Date(input.nowMs).toISOString();
    const limit = Math.max(1, input.limit);
    const rows = this.database
      .prepare(
        `SELECT request_id, id, from_agent_did, to_agent_did, conversation_id,
                reply_to, payload, payload_bytes, received_at, next_attempt_at,
                attempt_count, last_attempt_at, last_error
           FROM inbox_pending
          WHERE next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, received_at ASC
          LIMIT ?`,
      )
      .all(nowAt, limit) as Array<Parameters<typeof toPendingItem>[0]>;

    return rows.map((row) => toPendingItem(row));
  }

  async listDeadLetter(input?: {
    limit?: number;
  }): Promise<ConnectorInboundDeadLetterItem[]> {
    const rows =
      input?.limit === undefined
        ? (this.database
            .prepare(
              `SELECT request_id, id, from_agent_did, to_agent_did, conversation_id,
                      reply_to, payload, payload_bytes, received_at, next_attempt_at,
                      attempt_count, last_attempt_at, last_error, dead_lettered_at,
                      dead_letter_reason
                 FROM inbox_dead_letter
                ORDER BY dead_lettered_at ASC, received_at ASC`,
            )
            .all() as Array<Parameters<typeof toDeadLetterItem>[0]>)
        : (this.database
            .prepare(
              `SELECT request_id, id, from_agent_did, to_agent_did, conversation_id,
                      reply_to, payload, payload_bytes, received_at, next_attempt_at,
                      attempt_count, last_attempt_at, last_error, dead_lettered_at,
                      dead_letter_reason
                 FROM inbox_dead_letter
                ORDER BY dead_lettered_at ASC, received_at ASC
                LIMIT ?`,
            )
            .all(Math.max(1, input.limit)) as Array<
            Parameters<typeof toDeadLetterItem>[0]
          >);

    return rows.map((row) => toDeadLetterItem(row));
  }

  async getSnapshot(): Promise<ConnectorInboundInboxSnapshot> {
    const pendingRow = this.database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(payload_bytes), 0) AS bytes,
                MIN(received_at) AS oldest_pending_at,
                MIN(next_attempt_at) AS next_attempt_at
           FROM inbox_pending`,
      )
      .get() as PendingSnapshotRow;
    const deadLetterRow = this.database
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(payload_bytes), 0) AS bytes,
                MIN(dead_lettered_at) AS oldest_dead_letter_at
           FROM inbox_dead_letter`,
      )
      .get() as DeadLetterSnapshotRow;

    return {
      pending: {
        pendingCount: toSafeCount(pendingRow.count),
        pendingBytes: toSafeCount(pendingRow.bytes),
        oldestPendingAt: pendingRow.oldest_pending_at ?? undefined,
        nextAttemptAt: pendingRow.next_attempt_at ?? undefined,
      },
      deadLetter: {
        deadLetterCount: toSafeCount(deadLetterRow.count),
        deadLetterBytes: toSafeCount(deadLetterRow.bytes),
        oldestDeadLetterAt: deadLetterRow.oldest_dead_letter_at ?? undefined,
      },
    };
  }

  runInTransaction<T>(fn: (transaction: InboundInboxWriteTransaction) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const transaction = this.createWriteTransaction();
      const result = fn(transaction);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private createWriteTransaction(): InboundInboxWriteTransaction {
    return {
      appendEvent: (event) => {
        const row = toEventRow(event);
        this.database
          .prepare(
            `INSERT INTO inbox_events (type, request_id, details, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(row.type, row.request_id, row.details, nowIso());
        this.pruneEvents();
      },
      deleteDeadLetter: (requestId) => {
        const result = this.database
          .prepare("DELETE FROM inbox_dead_letter WHERE request_id = ?")
          .run(requestId);
        return result.changes > 0;
      },
      deletePending: (requestId) => {
        const result = this.database
          .prepare("DELETE FROM inbox_pending WHERE request_id = ?")
          .run(requestId);
        return result.changes > 0;
      },
      getDeadLetter: (requestId) => {
        const row = this.database
          .prepare(
            `SELECT request_id, id, from_agent_did, to_agent_did, conversation_id,
                    reply_to, payload, payload_bytes, received_at, next_attempt_at,
                    attempt_count, last_attempt_at, last_error, dead_lettered_at,
                    dead_letter_reason
               FROM inbox_dead_letter
              WHERE request_id = ?`,
          )
          .get(requestId) as Parameters<typeof toDeadLetterItem>[0] | undefined;
        return row ? toDeadLetterItem(row) : undefined;
      },
      getDeadLetterRequestIds: () => {
        const rows = this.database
          .prepare(
            `SELECT request_id
               FROM inbox_dead_letter
              ORDER BY dead_lettered_at ASC, received_at ASC`,
          )
          .all() as RequestIdRow[];
        return rows.map((row) => row.request_id);
      },
      getPending: (requestId) => {
        const row = this.database
          .prepare(
            `SELECT request_id, id, from_agent_did, to_agent_did, conversation_id,
                    reply_to, payload, payload_bytes, received_at, next_attempt_at,
                    attempt_count, last_attempt_at, last_error
               FROM inbox_pending
              WHERE request_id = ?`,
          )
          .get(requestId) as Parameters<typeof toPendingItem>[0] | undefined;
        return row ? toPendingItem(row) : undefined;
      },
      getPendingTotals: () => {
        const row = this.database
          .prepare(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(payload_bytes), 0) AS bytes
               FROM inbox_pending`,
          )
          .get() as CountBytesRow;
        return {
          pendingCount: toSafeCount(row.count),
          pendingBytes: toSafeCount(row.bytes),
        };
      },
      getPruneCounts: () => {
        const beforePendingCount = this.readTableCount("inbox_pending");
        const beforeDeadLetterCount = this.readTableCount("inbox_dead_letter");
        this.database.exec(
          "DELETE FROM inbox_pending WHERE attempt_count < 0; DELETE FROM inbox_dead_letter WHERE attempt_count < 0;",
        );
        return {
          beforePendingCount,
          beforeDeadLetterCount,
          afterPendingCount: this.readTableCount("inbox_pending"),
          afterDeadLetterCount: this.readTableCount("inbox_dead_letter"),
        };
      },
      hasRequest: (requestId) => {
        const row = this.database
          .prepare(
            `SELECT 1 AS present
               FROM (
                 SELECT request_id FROM inbox_pending WHERE request_id = ?
                 UNION ALL
                 SELECT request_id FROM inbox_dead_letter WHERE request_id = ?
               )
              LIMIT 1`,
          )
          .get(requestId, requestId) as { present?: number } | undefined;
        return row?.present === 1;
      },
      insertDeadLetter: (item) => {
        const row = toDeadLetterRow(item);
        this.database
          .prepare(
            `INSERT INTO inbox_dead_letter (
               request_id, id, from_agent_did, to_agent_did, conversation_id,
               reply_to, payload, payload_bytes, received_at, next_attempt_at,
               attempt_count, last_attempt_at, last_error, dead_lettered_at,
               dead_letter_reason
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.request_id,
            row.id,
            row.from_agent_did,
            row.to_agent_did,
            row.conversation_id,
            row.reply_to,
            row.payload,
            row.payload_bytes,
            row.received_at,
            row.next_attempt_at,
            row.attempt_count,
            row.last_attempt_at,
            row.last_error,
            row.dead_lettered_at,
            row.dead_letter_reason,
          );
      },
      insertPending: (item) => {
        const row = toPendingRow(item);
        this.database
          .prepare(
            `INSERT INTO inbox_pending (
               request_id, id, from_agent_did, to_agent_did, conversation_id,
               reply_to, payload, payload_bytes, received_at, next_attempt_at,
               attempt_count, last_attempt_at, last_error
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.request_id,
            row.id,
            row.from_agent_did,
            row.to_agent_did,
            row.conversation_id,
            row.reply_to,
            row.payload,
            row.payload_bytes,
            row.received_at,
            row.next_attempt_at,
            row.attempt_count,
            row.last_attempt_at,
            row.last_error,
          );
      },
      updatePending: (item) => {
        const row = toPendingRow(item);
        this.database
          .prepare(
            `UPDATE inbox_pending
                SET id = ?,
                    from_agent_did = ?,
                    to_agent_did = ?,
                    conversation_id = ?,
                    reply_to = ?,
                    payload = ?,
                    payload_bytes = ?,
                    received_at = ?,
                    next_attempt_at = ?,
                    attempt_count = ?,
                    last_attempt_at = ?,
                    last_error = ?
              WHERE request_id = ?`,
          )
          .run(
            row.id,
            row.from_agent_did,
            row.to_agent_did,
            row.conversation_id,
            row.reply_to,
            row.payload,
            row.payload_bytes,
            row.received_at,
            row.next_attempt_at,
            row.attempt_count,
            row.last_attempt_at,
            row.last_error,
            row.request_id,
          );
      },
    };
  }

  private pruneEvents(): void {
    const thresholdRow = this.database
      .prepare(
        `SELECT id
           FROM inbox_events
          ORDER BY id DESC
          LIMIT 1 OFFSET ?`,
      )
      .get(this.eventsMaxRows - 1) as { id?: number } | undefined;
    const thresholdId = thresholdRow?.id;
    if (thresholdId === undefined) {
      return;
    }

    this.database
      .prepare("DELETE FROM inbox_events WHERE id < ?")
      .run(thresholdId);
  }

  private readTableCount(
    tableName: "inbox_dead_letter" | "inbox_pending",
  ): number {
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get() as { count?: number };
    return toSafeCount(row.count);
  }
}
