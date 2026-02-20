import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    eventsMaxBytes: 1024 * 1024,
    eventsMaxFiles: 5,
  });
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
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
        payload: { message: "hello" },
      });
      expect(first.accepted).toBe(true);
      expect(first.duplicate).toBe(false);

      const second = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000000",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
        payload: { message: "hello" },
      });
      expect(second.accepted).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(second.pendingCount).toBe(1);

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pending.pendingCount).toBe(1);
      expect(snapshot.pending.pendingBytes).toBeGreaterThan(0);
      expect(snapshot.deadLetter.deadLetterCount).toBe(0);

      const inboxDir = resolveConnectorInboundInboxDir({
        configDir: sandbox.rootDir,
        agentName: "alpha",
      });
      const indexPath = join(inboxDir, "index.json");
      const eventsPath = join(inboxDir, "events.jsonl");

      const indexRaw = readFileSync(indexPath, "utf8");
      expect(indexRaw).toContain('"version": 2');
      expect(indexRaw).toContain("pendingByRequestId");
      expect(indexRaw).toContain("deadLetterByRequestId");

      const eventsRaw = readFileSync(eventsPath, "utf8");
      expect(eventsRaw).toContain("inbound_persisted");
      expect(eventsRaw).toContain("inbound_duplicate");
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
        eventsMaxBytes: 1024 * 1024,
        eventsMaxFiles: 5,
      });

      const accepted = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000001",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
        payload: { message: "small" },
      });
      expect(accepted.accepted).toBe(true);

      const rejectedByCount = await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000002",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
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
          eventsMaxBytes: 1024 * 1024,
          eventsMaxFiles: 5,
        });

        const rejectedByBytes = await byteCapped.enqueue({
          v: 1,
          type: "deliver",
          id: "01HXYZTESTDELIVER000000000003",
          ts: "2026-01-01T00:00:00.000Z",
          fromAgentDid: "did:claw:agent:sender",
          toAgentDid: "did:claw:agent:receiver",
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
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
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
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
        payload: { message: "first" },
      });
      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: secondId,
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
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

      const purgeResult = await inbox.purgeDeadLetter({
        requestIds: [secondId],
      });
      expect(purgeResult.purgedCount).toBe(1);

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

  it("gracefully handles missing index file", async () => {
    const sandbox = createSandbox();

    try {
      const inboxDir = resolveConnectorInboundInboxDir({
        configDir: sandbox.rootDir,
        agentName: "alpha",
      });
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
});
