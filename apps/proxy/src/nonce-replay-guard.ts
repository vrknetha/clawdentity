import { nowUtcMs } from "@clawdentity/sdk";
import {
  NONCE_REPLAY_GUARD_ROUTES,
  NONCE_REPLAY_STORAGE_PREFIX,
  type NonceReplayRecord,
  type NonceReplayTryAcceptRequest,
} from "./nonce-replay-contract.js";

function toErrorResponse(input: {
  code: string;
  message: string;
  status: number;
}): Response {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
      },
    },
    { status: input.status },
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseTryAcceptBody(
  body: unknown,
): NonceReplayTryAcceptRequest | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const parsed = body as Partial<NonceReplayTryAcceptRequest>;
  if (
    !isNonEmptyString(parsed.agentDid) ||
    !isNonEmptyString(parsed.nonce) ||
    typeof parsed.ttlMs !== "number" ||
    !Number.isFinite(parsed.ttlMs) ||
    !Number.isInteger(parsed.ttlMs) ||
    parsed.ttlMs <= 0
  ) {
    return undefined;
  }

  if (
    parsed.nowMs !== undefined &&
    (typeof parsed.nowMs !== "number" ||
      !Number.isFinite(parsed.nowMs) ||
      !Number.isInteger(parsed.nowMs) ||
      parsed.nowMs < 0)
  ) {
    return undefined;
  }

  return {
    agentDid: parsed.agentDid.trim(),
    nonce: parsed.nonce.trim(),
    ttlMs: parsed.ttlMs,
    ...(parsed.nowMs !== undefined ? { nowMs: parsed.nowMs } : {}),
  };
}

function toNonceStorageKey(agentDid: string, nonce: string): string {
  return `${NONCE_REPLAY_STORAGE_PREFIX}${encodeURIComponent(agentDid)}|${encodeURIComponent(nonce)}`;
}

export class NonceReplayGuard {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);
    if (url.pathname === NONCE_REPLAY_GUARD_ROUTES.tryAccept) {
      return this.handleTryAccept(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowMs = nowUtcMs();
    const entries = await this.state.storage.list<NonceReplayRecord>({
      prefix: NONCE_REPLAY_STORAGE_PREFIX,
    });

    const expiredKeys: string[] = [];
    let nextExpiry: number | undefined;
    for (const [key, value] of entries.entries()) {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.expiresAt !== "number" ||
        !Number.isFinite(value.expiresAt)
      ) {
        expiredKeys.push(key);
        continue;
      }

      if (value.expiresAt <= nowMs) {
        expiredKeys.push(key);
        continue;
      }

      if (nextExpiry === undefined || value.expiresAt < nextExpiry) {
        nextExpiry = value.expiresAt;
      }
    }

    if (expiredKeys.length > 0) {
      await this.state.storage.delete(expiredKeys);
    }

    if (nextExpiry === undefined) {
      await this.state.storage.deleteAlarm();
      return;
    }

    await this.state.storage.setAlarm(nextExpiry);
  }

  private async handleTryAccept(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return toErrorResponse({
        code: "NONCE_REPLAY_GUARD_INVALID_INPUT",
        message: "Nonce replay guard input is invalid",
        status: 400,
      });
    }

    const parsed = parseTryAcceptBody(payload);
    if (!parsed) {
      return toErrorResponse({
        code: "NONCE_REPLAY_GUARD_INVALID_INPUT",
        message: "Nonce replay guard input is invalid",
        status: 400,
      });
    }

    const nowMs = parsed.nowMs ?? nowUtcMs();
    const storageKey = toNonceStorageKey(parsed.agentDid, parsed.nonce);
    const result = await this.state.storage.transaction(async (txn) => {
      const existing = await txn.get<NonceReplayRecord>(storageKey);
      if (existing && existing.expiresAt > nowMs) {
        return {
          accepted: false as const,
          reason: "replay" as const,
          seenAt: existing.seenAt,
          expiresAt: existing.expiresAt,
        };
      }

      const seenAt = nowMs;
      const expiresAt = seenAt + parsed.ttlMs;
      await txn.put(storageKey, {
        seenAt,
        expiresAt,
      } satisfies NonceReplayRecord);

      const currentAlarm = await txn.getAlarm();
      if (currentAlarm === null || expiresAt < currentAlarm) {
        await txn.setAlarm(expiresAt);
      }

      return {
        accepted: true as const,
        seenAt,
        expiresAt,
      };
    });

    return Response.json(result);
  }
}
