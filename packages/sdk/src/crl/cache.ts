import { parseCrlClaims } from "@clawdentity/protocol";
import { AppError } from "../exceptions.js";
import type { CrlClaims } from "../jwt/crl-jwt.js";

export const DEFAULT_CRL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_CRL_MAX_AGE_MS = 15 * 60 * 1000;

export type CrlCacheStaleBehavior = "fail-open" | "fail-closed";

export type CrlCacheWarning = {
  code: "CRL_REFRESH_FAILED" | "CRL_STALE";
  message: string;
  details?: Record<string, unknown>;
};

export type CrlCacheRefreshResult = {
  refreshed: boolean;
  stale: boolean;
  warnings: CrlCacheWarning[];
  fetchedAtMs: number | null;
};

export type CrlCacheOptions = {
  fetchLatest: () => Promise<unknown>;
  refreshIntervalMs?: number;
  maxAgeMs?: number;
  staleBehavior?: CrlCacheStaleBehavior;
  clock?: () => number;
  initialClaims?: unknown;
  initialFetchedAtMs?: number;
};

export interface CrlCache {
  refreshIfStale(): Promise<CrlCacheRefreshResult>;
  isRevoked(jti: string): Promise<boolean>;
}

function invalidConfig(field: string, message: string): AppError {
  return new AppError({
    code: "CRL_CACHE_INVALID_CONFIG",
    message,
    status: 500,
    details: { field },
  });
}

function invalidInput(field: string): AppError {
  return new AppError({
    code: "CRL_CACHE_INVALID_INPUT",
    message: "CRL cache input must be a non-empty string",
    status: 400,
    details: { field },
  });
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field);
  }
  return value;
}

function ensurePositiveNumber(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw invalidConfig(
      field,
      "CRL cache timing values must be positive numbers",
    );
  }
  return resolved;
}

function ensureOptionalTimestamp(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw invalidConfig(
      "initialFetchedAtMs",
      "initialFetchedAtMs must be a non-negative number",
    );
  }

  return value;
}

function ensureStaleBehavior(value: unknown): CrlCacheStaleBehavior {
  if (value === "fail-open" || value === "fail-closed") {
    return value;
  }

  throw invalidConfig(
    "staleBehavior",
    "staleBehavior must be either fail-open or fail-closed",
  );
}

function staleCacheError(details: {
  maxAgeMs: number;
  lastSuccessfulRefreshAtMs: number | null;
  lastRefreshAttemptAtMs: number | null;
}): AppError {
  return new AppError({
    code: "CRL_CACHE_STALE",
    message: "CRL cache is stale and cannot be refreshed",
    status: 503,
    details,
  });
}

export function createCrlCache(options: CrlCacheOptions): CrlCache {
  if (typeof options !== "object" || options === null) {
    throw invalidConfig("options", "CRL cache options must be an object");
  }

  if (typeof options.fetchLatest !== "function") {
    throw invalidConfig(
      "fetchLatest",
      "CRL cache requires a fetchLatest function",
    );
  }

  const refreshIntervalMs = ensurePositiveNumber(
    options.refreshIntervalMs,
    DEFAULT_CRL_REFRESH_INTERVAL_MS,
    "refreshIntervalMs",
  );
  const maxAgeMs = ensurePositiveNumber(
    options.maxAgeMs,
    DEFAULT_CRL_MAX_AGE_MS,
    "maxAgeMs",
  );
  const staleBehavior = ensureStaleBehavior(
    options.staleBehavior ?? "fail-open",
  );
  const clock = options.clock ?? Date.now;

  let claims: CrlClaims | null =
    options.initialClaims === undefined
      ? null
      : parseCrlClaims(options.initialClaims);
  let lastSuccessfulRefreshAtMs = ensureOptionalTimestamp(
    options.initialFetchedAtMs,
  );

  if (claims !== null && lastSuccessfulRefreshAtMs === null) {
    lastSuccessfulRefreshAtMs = clock();
  }

  if (claims === null && lastSuccessfulRefreshAtMs !== null) {
    throw invalidConfig(
      "initialFetchedAtMs",
      "initialFetchedAtMs requires initialClaims",
    );
  }

  let lastRefreshAttemptAtMs: number | null = null;

  function ageMs(now: number): number {
    if (lastSuccessfulRefreshAtMs === null) {
      return Number.POSITIVE_INFINITY;
    }
    return now - lastSuccessfulRefreshAtMs;
  }

  function isStale(now: number): boolean {
    return claims === null || ageMs(now) > maxAgeMs;
  }

  function shouldRefresh(now: number): boolean {
    return claims === null || ageMs(now) >= refreshIntervalMs || isStale(now);
  }

  function canAttemptRefresh(now: number): boolean {
    return (
      lastRefreshAttemptAtMs === null ||
      now - lastRefreshAttemptAtMs >= refreshIntervalMs
    );
  }

  async function refreshIfStale(): Promise<CrlCacheRefreshResult> {
    const warnings: CrlCacheWarning[] = [];
    let refreshed = false;
    const now = clock();
    const staleBeforeRefresh = isStale(now);

    if (shouldRefresh(now) && (staleBeforeRefresh || canAttemptRefresh(now))) {
      lastRefreshAttemptAtMs = now;
      try {
        const nextClaims = parseCrlClaims(await options.fetchLatest());
        claims = nextClaims;
        lastSuccessfulRefreshAtMs = now;
        refreshed = true;
      } catch (error) {
        warnings.push({
          code: "CRL_REFRESH_FAILED",
          message: "CRL refresh attempt failed",
          details: {
            reason: error instanceof Error ? error.message : "unknown",
          },
        });
      }
    }

    const stale = isStale(now);
    if (stale) {
      warnings.push({
        code: "CRL_STALE",
        message: "CRL cache is stale",
        details: {
          ageMs: Number.isFinite(ageMs(now)) ? ageMs(now) : null,
          maxAgeMs,
        },
      });

      if (staleBehavior === "fail-closed") {
        throw staleCacheError({
          maxAgeMs,
          lastSuccessfulRefreshAtMs,
          lastRefreshAttemptAtMs,
        });
      }
    }

    return {
      refreshed,
      stale,
      warnings,
      fetchedAtMs: lastSuccessfulRefreshAtMs,
    };
  }

  async function isRevoked(jtiInput: string): Promise<boolean> {
    const jti = ensureNonEmptyString(jtiInput, "jti");
    await refreshIfStale();

    if (claims === null) {
      return false;
    }

    return claims.revocations.some((revocation) => revocation.jti === jti);
  }

  return {
    refreshIfStale,
    isRevoked,
  };
}
