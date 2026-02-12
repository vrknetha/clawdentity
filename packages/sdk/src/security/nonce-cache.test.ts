import { describe, expect, it } from "vitest";
import { createNonceCache, DEFAULT_NONCE_TTL_MS } from "./nonce-cache.js";

describe("nonce cache", () => {
  it("rejects duplicate nonce for same agent within ttl", () => {
    const now = 1_000;
    const cache = createNonceCache({
      ttlMs: DEFAULT_NONCE_TTL_MS,
      clock: () => now,
    });

    const first = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-1",
    });
    const second = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
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
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-2",
    });
    now += ttlMs + 1;
    const second = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
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
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-shared",
    });
    const second = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-3",
    });
    now += 101;
    cache.purgeExpired();

    const next = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-3",
    });
    expect(next.accepted).toBe(true);
  });
});
