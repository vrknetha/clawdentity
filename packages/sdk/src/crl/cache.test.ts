import { describe, expect, it } from "vitest";
import type { CrlClaims } from "../jwt/crl-jwt.js";
import {
  createCrlCache,
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
} from "./cache.js";

const REGISTRY_ISSUER = "https://registry.clawdentity.dev";
const AGENT_DID =
  "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4";
const CRL_JTI = "01HF7YAT4TXP6AW5QNXA2Y9K43";
const REVOCATION_JTI_A = "01HF7YAT31JZHSMW1CG6Q6MHB7";
const REVOCATION_JTI_B = "01HF7YAT5QJ4K3YVQJ6Q2F9M1N";

function makeClaims(revocationJti: string): CrlClaims {
  return {
    iss: REGISTRY_ISSUER,
    jti: CRL_JTI,
    iat: 1_700_000_000,
    exp: 1_700_003_600,
    revocations: [
      {
        jti: revocationJti,
        agentDid: AGENT_DID,
        reason: "manual revoke",
        revokedAt: 1_700_000_100,
      },
    ],
  };
}

describe("crl cache", () => {
  it("uses sensible default timing values", () => {
    expect(DEFAULT_CRL_REFRESH_INTERVAL_MS).toBe(300000);
    expect(DEFAULT_CRL_MAX_AGE_MS).toBe(900000);
  });

  it("checks revoked jti after loading claims", async () => {
    const cache = createCrlCache({
      fetchLatest: async () => makeClaims(REVOCATION_JTI_A),
      clock: () => 1_000,
    });

    await expect(cache.isRevoked(REVOCATION_JTI_A)).resolves.toBe(true);
    await expect(cache.isRevoked(REVOCATION_JTI_B)).resolves.toBe(false);
  });

  it("attempts refresh for stale cache and surfaces warnings when refresh fails in fail-open mode", async () => {
    let now = 500;
    let fetchCalls = 0;
    const cache = createCrlCache({
      fetchLatest: async () => {
        fetchCalls += 1;
        throw new Error("network down");
      },
      staleBehavior: "fail-open",
      refreshIntervalMs: 100,
      maxAgeMs: 200,
      initialClaims: makeClaims(REVOCATION_JTI_A),
      initialFetchedAtMs: 0,
      clock: () => now,
    });

    const result = await cache.refreshIfStale();

    expect(fetchCalls).toBe(1);
    expect(result.refreshed).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "CRL_REFRESH_FAILED",
      "CRL_STALE",
    ]);

    now += 50;
    const second = await cache.refreshIfStale();
    expect(fetchCalls).toBe(2);
    expect(second.warnings.map((warning) => warning.code)).toEqual([
      "CRL_REFRESH_FAILED",
      "CRL_STALE",
    ]);
  });

  it("throws in fail-closed mode when stale cache cannot refresh", async () => {
    const cache = createCrlCache({
      fetchLatest: async () => {
        throw new Error("registry unavailable");
      },
      staleBehavior: "fail-closed",
      refreshIntervalMs: 100,
      maxAgeMs: 200,
      clock: () => 1_000,
    });

    await expect(cache.refreshIfStale()).rejects.toMatchObject({
      code: "CRL_CACHE_STALE",
    });
  });

  it("attempts refresh immediately when cache is stale even before refresh interval", async () => {
    let now = 0;
    let fetchCalls = 0;
    const cache = createCrlCache({
      fetchLatest: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          throw new Error("temporary outage");
        }
        return makeClaims(REVOCATION_JTI_A);
      },
      staleBehavior: "fail-open",
      refreshIntervalMs: 1000,
      maxAgeMs: 100,
      clock: () => now,
    });

    const first = await cache.refreshIfStale();
    expect(first.stale).toBe(true);
    expect(fetchCalls).toBe(1);

    now = 150;
    const second = await cache.refreshIfStale();
    expect(fetchCalls).toBe(2);
    expect(second.refreshed).toBe(true);
    expect(second.stale).toBe(false);
  });

  it("refreshes when interval elapsed and uses latest revocation list", async () => {
    const now = 150;
    let currentClaims = makeClaims(REVOCATION_JTI_A);
    const cache = createCrlCache({
      fetchLatest: async () => currentClaims,
      refreshIntervalMs: 100,
      maxAgeMs: 1_000,
      initialClaims: makeClaims(REVOCATION_JTI_A),
      initialFetchedAtMs: 0,
      clock: () => now,
    });

    currentClaims = makeClaims(REVOCATION_JTI_B);

    const result = await cache.refreshIfStale();
    expect(result.refreshed).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.warnings).toEqual([]);

    await expect(cache.isRevoked(REVOCATION_JTI_A)).resolves.toBe(false);
    await expect(cache.isRevoked(REVOCATION_JTI_B)).resolves.toBe(true);
  });

  it("rejects invalid jti input with structured app error", async () => {
    const cache = createCrlCache({
      fetchLatest: async () => makeClaims(REVOCATION_JTI_A),
      clock: () => 0,
    });

    await expect(cache.isRevoked("   ")).rejects.toMatchObject({
      code: "CRL_CACHE_INVALID_INPUT",
      details: {
        field: "jti",
      },
    });
  });
});
