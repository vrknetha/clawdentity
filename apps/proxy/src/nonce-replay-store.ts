import { parseJsonResponseSafe as parseJsonResponse } from "@clawdentity/common";
import type {
  ProxyNonceCache,
  ProxyNonceCacheResult,
} from "./auth-middleware/types.js";
import {
  NONCE_REPLAY_GUARD_DO_NAME,
  NONCE_REPLAY_GUARD_ROUTES,
  type NonceReplayTryAcceptRequest,
} from "./nonce-replay-contract.js";

export type NonceReplayGuardStub = {
  fetch(request: Request): Promise<Response>;
};

export type NonceReplayGuardNamespace = {
  get: (id: DurableObjectId) => NonceReplayGuardStub;
  idFromName: (name: string) => DurableObjectId;
};

export class NonceReplayStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; message: string; status: number }) {
    super(input.message);
    this.name = "NonceReplayStoreError";
    this.code = input.code;
    this.status = input.status;
  }
}

function parseErrorPayload(payload: unknown): {
  code: string;
  message: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return {
      code: "NONCE_REPLAY_GUARD_ERROR",
      message: "Nonce replay guard operation failed",
    };
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {
      code: "NONCE_REPLAY_GUARD_ERROR",
      message: "Nonce replay guard operation failed",
    };
  }

  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "NONCE_REPLAY_GUARD_ERROR";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Nonce replay guard operation failed";

  return { code, message };
}

function createDurableObjectRequest(path: string, payload: unknown): Request {
  return new Request(`https://nonce-replay-guard${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function resolveDurableGuardStub(
  namespace: NonceReplayGuardNamespace,
): NonceReplayGuardStub {
  return namespace.get(namespace.idFromName(NONCE_REPLAY_GUARD_DO_NAME));
}

async function callDurableGuard<T>(
  namespace: NonceReplayGuardNamespace,
  path: string,
  payload: unknown,
): Promise<T> {
  const stub = resolveDurableGuardStub(namespace);
  const response = await stub.fetch(createDurableObjectRequest(path, payload));
  if (!response.ok) {
    const parsed = parseErrorPayload(await parseJsonResponse(response));
    throw new NonceReplayStoreError({
      code: parsed.code,
      message: parsed.message,
      status: response.status,
    });
  }

  return (await response.json()) as T;
}

export function createDurableNonceReplayStore(
  namespace: NonceReplayGuardNamespace,
  options?: { ttlMs?: number },
): ProxyNonceCache {
  const ttlMs = options?.ttlMs;

  return {
    async tryAcceptNonce(input) {
      const payload: NonceReplayTryAcceptRequest = {
        agentDid: input.agentDid,
        nonce: input.nonce,
        ttlMs: input.ttlMs ?? ttlMs ?? 0,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      };

      return callDurableGuard<ProxyNonceCacheResult>(
        namespace,
        NONCE_REPLAY_GUARD_ROUTES.tryAccept,
        payload,
      );
    },
    async purgeExpired() {
      return;
    },
  };
}
