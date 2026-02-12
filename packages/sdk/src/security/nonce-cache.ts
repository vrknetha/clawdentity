import { AppError } from "../exceptions.js";

export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000;

export type NonceCacheOptions = {
  ttlMs?: number;
  clock?: () => number;
};

export type NonceCacheInput = {
  agentDid: string;
  nonce: string;
};

export type NonceCacheResult =
  | {
      accepted: true;
      seenAt: number;
      expiresAt: number;
    }
  | {
      accepted: false;
      reason: "replay";
      seenAt: number;
      expiresAt: number;
    };

export interface NonceCache {
  tryAcceptNonce(input: NonceCacheInput): NonceCacheResult;
  purgeExpired(): void;
}

type NonceRecord = {
  seenAt: number;
  expiresAt: number;
};

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError({
      code: "NONCE_CACHE_INVALID_INPUT",
      message: "Nonce cache input must be a non-empty string",
      status: 400,
      details: { field },
    });
  }

  return value;
}

function resolveTtlMs(ttlMs: number | undefined): number {
  const ttl = ttlMs ?? DEFAULT_NONCE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new AppError({
      code: "NONCE_CACHE_INVALID_TTL",
      message: "Nonce cache ttl must be a positive number",
      status: 500,
      details: { ttlMs: ttl },
    });
  }
  return ttl;
}

function pruneExpiredFromAgent(
  agentMap: Map<string, NonceRecord>,
  now: number,
) {
  for (const [nonce, record] of agentMap.entries()) {
    if (record.expiresAt <= now) {
      agentMap.delete(nonce);
    }
  }
}

export function createNonceCache(options: NonceCacheOptions = {}): NonceCache {
  const ttlMs = resolveTtlMs(options.ttlMs);
  const clock = options.clock ?? Date.now;
  const seenByAgent = new Map<string, Map<string, NonceRecord>>();

  function purgeExpired(): void {
    const now = clock();
    for (const [agentDid, agentMap] of seenByAgent.entries()) {
      pruneExpiredFromAgent(agentMap, now);
      if (agentMap.size === 0) {
        seenByAgent.delete(agentDid);
      }
    }
  }

  function tryAcceptNonce(input: NonceCacheInput): NonceCacheResult {
    const agentDid = ensureNonEmptyString(input.agentDid, "agentDid");
    const nonce = ensureNonEmptyString(input.nonce, "nonce");
    const now = clock();

    let agentMap = seenByAgent.get(agentDid);
    if (!agentMap) {
      agentMap = new Map<string, NonceRecord>();
      seenByAgent.set(agentDid, agentMap);
    }

    pruneExpiredFromAgent(agentMap, now);

    const existing = agentMap.get(nonce);
    if (existing) {
      return {
        accepted: false,
        reason: "replay",
        seenAt: existing.seenAt,
        expiresAt: existing.expiresAt,
      };
    }

    const seenAt = now;
    const expiresAt = now + ttlMs;
    agentMap.set(nonce, {
      seenAt,
      expiresAt,
    });

    return {
      accepted: true,
      seenAt,
      expiresAt,
    };
  }

  return {
    tryAcceptNonce,
    purgeExpired,
  };
}
