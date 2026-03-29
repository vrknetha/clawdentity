export const NONCE_REPLAY_GUARD_DO_NAME = "global-nonce-replay";

export const NONCE_REPLAY_GUARD_ROUTES = {
  tryAccept: "/nonce/try-accept",
} as const;

export type NonceReplayTryAcceptRequest = {
  agentDid: string;
  nonce: string;
  ttlMs: number;
  nowMs?: number;
};

export type NonceReplayRecord = {
  seenAt: number;
  expiresAt: number;
};

export const NONCE_REPLAY_STORAGE_PREFIX = "nonce:";
