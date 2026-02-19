import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  // no-op hook for symmetry and future timer cleanup
});

describe("ConnectorInboundInbox", () => {
  it("persists and deduplicates inbound frames", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createConnectorInboundInbox({
        configDir: sandbox.rootDir,
        agentName: "alpha",
        maxPendingMessages: 100,
        maxPendingBytes: 1024 * 1024,
      });

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
      expect(snapshot.pendingCount).toBe(1);
      expect(snapshot.pendingBytes).toBeGreaterThan(0);

      const inboxDir = resolveConnectorInboundInboxDir({
        configDir: sandbox.rootDir,
        agentName: "alpha",
      });
      const indexPath = join(inboxDir, "index.json");
      const eventsPath = join(inboxDir, "events.jsonl");

      const indexRaw = readFileSync(indexPath, "utf8");
      expect(indexRaw).toContain("pendingByRequestId");
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

  it("replays bookkeeping updates pending entries", async () => {
    const sandbox = createSandbox();

    try {
      const inbox = createConnectorInboundInbox({
        configDir: sandbox.rootDir,
        agentName: "alpha",
        maxPendingMessages: 100,
        maxPendingBytes: 1024 * 1024,
      });

      await inbox.enqueue({
        v: 1,
        type: "deliver",
        id: "01HXYZTESTDELIVER000000000004",
        ts: "2026-01-01T00:00:00.000Z",
        fromAgentDid: "did:claw:agent:sender",
        toAgentDid: "did:claw:agent:receiver",
        payload: { message: "hello" },
      });

      const dueNow = await inbox.listDuePending({
        nowMs: Date.now(),
        limit: 10,
      });
      expect(dueNow).toHaveLength(1);
      expect(dueNow[0]?.requestId).toBe("01HXYZTESTDELIVER000000000004");

      await inbox.markReplayFailure({
        requestId: "01HXYZTESTDELIVER000000000004",
        errorMessage: "hook unavailable",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const dueLater = await inbox.listDuePending({
        nowMs: Date.now(),
        limit: 10,
      });
      expect(dueLater).toHaveLength(0);

      await inbox.markDelivered("01HXYZTESTDELIVER000000000004");
      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pendingCount).toBe(0);
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

      const inbox = createConnectorInboundInbox({
        configDir: sandbox.rootDir,
        agentName: "alpha",
        maxPendingMessages: 100,
        maxPendingBytes: 1024 * 1024,
      });

      const snapshot = await inbox.getSnapshot();
      expect(snapshot.pendingCount).toBe(0);
      expect(snapshot.pendingBytes).toBe(0);
    } finally {
      sandbox.cleanup();
    }
  });
});
