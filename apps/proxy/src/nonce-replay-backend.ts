import { createNonceCache } from "@clawdentity/sdk";
import {
  DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  type ProxyNonceCache,
} from "./auth-middleware/types.js";
import { ProxyConfigError, type ProxyEnvironment } from "./config.js";
import {
  createDurableNonceReplayStore,
  type NonceReplayGuardNamespace,
} from "./nonce-replay-store.js";

export type NonceReplayBackend = "durable" | "memory";

type RuntimeTarget = "worker" | "node";

type NonceReplayResolution = {
  backend: NonceReplayBackend;
  nonceCache: ProxyNonceCache;
};

function toTtlMs(maxTimestampSkewSeconds?: number): number {
  return (maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS) * 1000;
}

function createInMemoryNonceReplayCache(input?: {
  maxTimestampSkewSeconds?: number;
}): ProxyNonceCache {
  const cache = createNonceCache({
    ttlMs: toTtlMs(input?.maxTimestampSkewSeconds),
  });

  return {
    tryAcceptNonce(request) {
      return cache.tryAcceptNonce({
        agentDid: request.agentDid,
        nonce: request.nonce,
      });
    },
    purgeExpired() {
      cache.purgeExpired();
    },
  };
}

function requiresDurableNonceReplay(environment: ProxyEnvironment): boolean {
  return environment === "development" || environment === "production";
}

function toMissingDurableNonceReplayError(input: {
  environment: ProxyEnvironment;
  runtime: RuntimeTarget;
}): ProxyConfigError {
  const runtimeHint =
    input.runtime === "worker"
      ? "Ensure NONCE_REPLAY_GUARD Durable Object binding is configured for this environment."
      : "Node runtime supports local in-memory nonce replay checks only. Use Worker runtime with NONCE_REPLAY_GUARD for non-local environments.";

  return new ProxyConfigError("Proxy configuration is invalid", {
    fieldErrors: {
      NONCE_REPLAY_GUARD: [
        `NONCE_REPLAY_GUARD is required when ENVIRONMENT is '${input.environment}'. ${runtimeHint}`,
      ],
    },
    formErrors: [],
  });
}

export function resolveWorkerNonceReplayStore(input: {
  environment: ProxyEnvironment;
  nonceReplayNamespace?: NonceReplayGuardNamespace;
  maxTimestampSkewSeconds?: number;
}): NonceReplayResolution {
  if (input.nonceReplayNamespace !== undefined) {
    return {
      backend: "durable",
      nonceCache: createDurableNonceReplayStore(input.nonceReplayNamespace, {
        ttlMs: toTtlMs(input.maxTimestampSkewSeconds),
      }),
    };
  }

  if (requiresDurableNonceReplay(input.environment)) {
    throw toMissingDurableNonceReplayError({
      environment: input.environment,
      runtime: "worker",
    });
  }

  return {
    backend: "memory",
    nonceCache: createInMemoryNonceReplayCache({
      maxTimestampSkewSeconds: input.maxTimestampSkewSeconds,
    }),
  };
}

export function resolveNodeNonceReplayStore(input: {
  environment: ProxyEnvironment;
  maxTimestampSkewSeconds?: number;
}): NonceReplayResolution {
  if (requiresDurableNonceReplay(input.environment)) {
    throw toMissingDurableNonceReplayError({
      environment: input.environment,
      runtime: "node",
    });
  }

  return {
    backend: "memory",
    nonceCache: createInMemoryNonceReplayCache({
      maxTimestampSkewSeconds: input.maxTimestampSkewSeconds,
    }),
  };
}
