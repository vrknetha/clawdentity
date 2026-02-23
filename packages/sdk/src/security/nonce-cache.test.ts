import { describe, expect, it } from "vitest";
import { createNonceCache, DEFAULT_NONCE_TTL_MS } from "./nonce-cache.js";

describe("nonce cache", () => {
  it("rejects non-object input with structured app error", () => {
    const cache = createNonceCache();

    try {
      cache.tryAcceptNonce(
        undefined as unknown as { agentDid: string; nonce: string },
      );
      throw new Error("expected tryAcceptNonce to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "NONCE_CACHE_INVALID_INPUT",
        details: {
          field: "input",
        },
      });
    }
  });

  it("rejects duplicate nonce for same agent within ttl", () => {
    const now = 1_000;
    const cache = createNonceCache({
      ttlMs: DEFAULT_NONCE_TTL_MS,
      clock: () => now,
    });

    const first = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-1",
    });
    const second = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-1",
    });

    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({
      accepted: false,
      reason: "replay",
    });
  });

  it("treats expired nonces as unseen", () => {
    let now = 2_000;
    const ttlMs = 100;
    const cache = createNonceCache({
      ttlMs,
      clock: () => now,
    });

    const first = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-2",
    });
    now += ttlMs + 1;
    const second = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-2",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
  });

  it("isolates nonce tracking per agent did", () => {
    const cache = createNonceCache({
      clock: () => 3_000,
    });

    const first = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-shared",
    });
    const second = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      nonce: "nonce-shared",
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
  });

  it("purges expired entries so future checks are accepted", () => {
    let now = 4_000;
    const cache = createNonceCache({
      ttlMs: 100,
      clock: () => now,
    });

    cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-3",
    });
    now += 101;
    cache.purgeExpired();

    const next = cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-3",
    });
    expect(next.accepted).toBe(true);
  });

  it("prunes expired entries across all agents during accept", () => {
    let now = 10_000;
    const targetNonce = "nonce-expired-other-agent";
    const cache = createNonceCache({
      ttlMs: 100,
      clock: () => now,
    });

    cache.tryAcceptNonce({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: targetNonce,
    });
    now += 101;

    const originalDelete = Map.prototype.delete;
    let removedExpiredNonce = false;

    Map.prototype.delete = function patchedDelete(
      this: Map<unknown, unknown>,
      key: unknown,
    ): boolean {
      if (key === targetNonce) {
        removedExpiredNonce = true;
      }
      return originalDelete.call(this, key);
    };

    try {
      cache.tryAcceptNonce({
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        nonce: "nonce-fresh",
      });
    } finally {
      Map.prototype.delete = originalDelete;
    }

    expect(removedExpiredNonce).toBe(true);
  });
});
