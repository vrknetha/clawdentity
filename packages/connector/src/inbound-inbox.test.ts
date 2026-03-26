import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOUND_INBOX_DB_FILE_NAME } from "./inbound-inbox/constants.js";
import {
  createConnectorInboundInbox,
  resolveConnectorInboundInboxDir,
} from "./inbound-inbox.js";

function createSandbox(): { cleanup: () => void; rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), "clawdentity-connector-inbox-"));
  return {
    rootDir,
    cleanup: () => {
      rmSync(rootDir, { force: true, recursive: true });
    },
  };
}

function createInbox(rootDir: string, agentName = "alpha") {
  return createConnectorInboundInbox({
    configDir: rootDir,
    agentName,
    maxPendingMessages: 100,
    maxPendingBytes: 1024 * 1024,
    eventsMaxRows: 1_000,
  });
}

function getInboxDir(rootDir: string, agentName = "alpha"): string {
  return resolveConnectorInboundInboxDir({
    configDir: rootDir,
    agentName,
  });
}

function getDatabasePath(rootDir: string, agentName = "alpha"): string {
  return join(getInboxDir(rootDir, agentName), INBOUND_INBOX_DB_FILE_NAME);
}

function readEventCount(inbox: object): number {
  const database = (
    inbox as unknown as {
      storage: {
        database: {
          prepare: (sql: string) => { get: () => { count: number } };
        };
      };
    }
  ).storage.database;
  return database.prepare("SELECT COUNT(*) AS count FROM inbox_events").get()
    .count;
}

function installEventFailureTrigger(inbox: object): void {
  const database = (
    inbox as unknown as {
      storage: {
        database: {
          exec: (sql: string) => void;
        };
      };
    }
  ).storage.database;
  database.exec(`
    CREATE TRIGGER fail_inbox_events_insert
    BEFORE INSERT ON inbox_events
    BEGIN
      SELECT RAISE(ABORT, 'forced inbox_events failure');
    END;
  `);
}

describe("ConnectorInboundInbox", () => {
  it("persists and deduplicates inbound frames", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createInbox(sandbox.rootDir);

      const first = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000000",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });
      expect(first.accepted).toBe(true);
      expect(first.duplicate).toBe(false);

      const second = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000000",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });
      expect(second.accepted).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.pendingCount).toBe(1);

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(1);
      expect(snapshot.pending.pendingBytes).toBeGreaterThan(0);
      expect(snapshot.deadLetter.deadLetterCount).toBe(0);

      const inboxDir = getInboxDir(sandbox.rootDir);
      const dbPath = getDatabasePath(sandbox.rootDir);
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(join(inboxDir, "index.json"))).toBe(false);
      expect(existsSync(join(inboxDir, "events.jsonl"))).toBe(false);
      expect(existsSync(join(inboxDir, "index.lock"))).toBe(false);
      expect(readEventCount(inbox)).toBe(2);
    } finally {
      sandbox.cleanup();
    }
  });

  it("enforces inbox size and message caps", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createConnectorInboundInbox({
        configDir: sandbox.rootDir,
        agentName: "alpha",
        maxPendingMessages: 1,
        maxPendingBytes: 64,
        eventsMaxRows: 1_000,
      });

      const accepted = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000001",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "small" },
      });
      expect(accepted.accepted).toBe(true);

      const rejectedByCount = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000002",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "next" },
      });
      expect(rejectedByCount.accepted).toBe(false);
      expect(rejectedByCount.reason).toContain("message cap");

      const sandbox2 = createSandbox();
      try {
        const byteCapped = createConnectorInboundInbox({
          configDir: sandbox2.rootDir,
          agentName: "beta",
          maxPendingMessages: 100,
          maxPendingBytes: 8,
          eventsMaxRows: 1_000,
        });

        const rejectedByBytes = await byteCapped.enqueue({
          v: 1,
          type: "deliver",
          id: "01HXYZTESTDELIVER000000000003",
          ts: "2026-01-01T00:00:00.000Z",
          fromAgentDid:
            "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
          toAgentDid:
            "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
          payload: { message: "this is too large" },
        });
        expect(rejectedByBytes.accepted).toBe(false);
        expect(rejectedByBytes.reason).toContain("byte cap");
      } finally {
        sandbox2.cleanup();
      }
    } finally {
      sandbox.cleanup();
    }
  });

  it("moves non-retryable replay failures to dead-letter after threshold", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createInbox(sandbox.rootDir);

      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000004",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });

      const firstFailure = await inbox.markReplayFailure({
        requestId: "01HXYZTESTDELIVER000000000004",
        errorMessage: "validation failed",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        retryable: false,
        maxNonRetryableAttempts: 2,
      });
      expect(firstFailure.movedToDeadLetter).toBe(false);

      const secondFailure = await inbox.markReplayFailure({
        requestId: "01HXYZTESTDELIVER000000000004",
        errorMessage: "validation failed",
        nextAttemptAt: new Date(Date.now() + 120_000).toISOString(),
        retryable: false,
        maxNonRetryableAttempts: 2,
      });
      expect(secondFailure.movedToDeadLetter).toBe(true);

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(0);
      expect(snapshot.deadLetter.deadLetterCount).toBe(1);

      const deadLetter = await inbox.listDeadLetter();
      expect(deadLetter).toHaveLength(1);
      expect(deadLetter[0]?.requestId).toBe("01HXYZTESTDELIVER000000000004");
      expect(deadLetter[0]?.deadLetterReason).toContain("validation failed");
    } finally {
      sandbox.cleanup();
    }
  });

  it("supports dead-letter replay and purge", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createInbox(sandbox.rootDir);
      const firstId = "01HXYZTESTDELIVER000000000005";
      const secondId = "01HXYZTESTDELIVER000000000006";

      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: firstId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "first" },
      });
      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: secondId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "second" },
      });

      await inbox.markReplayFailure({
        requestId: firstId,
        errorMessage: "hard failure",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        retryable: false,
        maxNonRetryableAttempts: 1,
      });
      await inbox.markReplayFailure({
        requestId: secondId,
        errorMessage: "hard failure",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        retryable: false,
        maxNonRetryableAttempts: 1,
      });

      const replayResult = await inbox.replayDeadLetter({
        requestIds: [firstId],
      });
      expect(replayResult.replayedCount).toBe(1);

      const replayNoOpResult = await inbox.replayDeadLetter({
        requestIds: [],
      });
      expect(replayNoOpResult.replayedCount).toBe(0);

      const purgeResult = await inbox.purgeDeadLetter({
        requestIds: [secondId],
      });
      expect(purgeResult.purgedCount).toBe(1);

      const purgeNoOpResult = await inbox.purgeDeadLetter({
        requestIds: [],
      });
      expect(purgeNoOpResult.purgedCount).toBe(0);

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(1);
      expect(snapshot.deadLetter.deadLetterCount).toBe(0);

      const dueNow = await inbox.listDuePending({
        nowMs: Date.now(),
        limit: 10,
      });
      expect(dueNow.map((item) => item.requestId)).toContain(firstId);
    } finally {
      sandbox.cleanup();
    }
  });

  it("gracefully handles a missing sqlite inbox file", async () => {
    const sandbox = createSandbox();

    try {
      const inboxDir = getInboxDir(sandbox.rootDir);
      mkdirSync(inboxDir, { recursive: true });

      const inbox = createInbox(sandbox.rootDir);
      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(0);
      expect(snapshot.pending.pendingBytes).toBe(0);
      expect(snapshot.deadLetter.deadLetterCount).toBe(0);
      expect(snapshot.deadLetter.deadLetterBytes).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });

  it("recreates a corrupt sqlite inbox file on first use", async () => {
    const sandbox = createSandbox();

    try {
      const dbPath = getDatabasePath(sandbox.rootDir);
      mkdirSync(getInboxDir(sandbox.rootDir), { recursive: true });
      writeFileSync(dbPath, "not a sqlite database", "utf8");

      const inbox = createInbox(sandbox.rootDir);
      const result = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000007",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });

      expect(result.accepted).toBe(true);
      expect((await inbox.getSnapshot()).pending.pendingCount).toBe(1);
    } finally {
      sandbox.cleanup();
    }
  });

  it("prunes inbox event rows to the configured max", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createConnectorInboundInbox({
        configDir: sandbox.rootDir,
        agentName: "alpha",
        maxPendingMessages: 100,
        maxPendingBytes: 1024 * 1024,
        eventsMaxRows: 3,
      });

      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000008",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });
      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000008",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
        toAgentDid:
          "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
        payload: { message: "hello" },
      });
      await inbox.markReplayFailure({
        requestId: "01HXYZTESTDELIVER000000000008",
        errorMessage: "retry later",
        nextAttemptAt: new Date(Date.now() + 1_000).toISOString(),
        retryable: true,
        maxNonRetryableAttempts: 3,
      });
      await inbox.markDelivered("01HXYZTESTDELIVER000000000008");

      expect(readEventCount(inbox)).toBe(3);
    } finally {
      sandbox.cleanup();
    }
  });

  it("rolls back pending writes when event persistence fails inside a transaction", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createInbox(sandbox.rootDir);
      installEventFailureTrigger(inbox);

      await expect(
        inbox.enqueue({
          v: 1,
          type: "deliver",
          id: "01HXYZTESTDELIVER000000000009",
          ts: "2026-01-01T00:00:00.000Z",
          fromAgentDid:
            "did:cdi:registry.example.test:agent:01HF7YAT00EXEKCZ140TBBFB97",
          toAgentDid:
            "did:cdi:registry.example.test:agent:01HF7YAT343FD48SE5Z15FNC01",
          payload: { message: "hello" },
        }),
      ).rejects.toThrow("forced inbox_events failure");

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(0);
      expect(snapshot.pending.pendingBytes).toBe(0);
      expect(snapshot.deadLetter.deadLetterCount).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });
});
