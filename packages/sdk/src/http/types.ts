import {
  X_CLAW_BODY_SHA256,
  X_CLAW_NONCE,
  X_CLAW_PROOF,
  X_CLAW_TIMESTAMP,
} from "./constants.js";

export type ClawSignatureHeaders = {
  [X_CLAW_TIMESTAMP]: string;
  [X_CLAW_NONCE]: string;
  [X_CLAW_BODY_SHA256]: string;
  [X_CLAW_PROOF]: string;
};

export interface SignHttpRequestInput {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  nonce: string;
  body?: Uint8Array;
  secretKey: Uint8Array;
}

export interface SignHttpRequestResult {
  canonicalRequest: string;
  proof: string;
  headers: ClawSignatureHeaders;
}

export interface VerifyHttpRequestInput {
  method: string;
  pathWithQuery: string;
  headers: Record<string, string | undefined>;
  body?: Uint8Array;
  publicKey: Uint8Array;
  nowMs?: number;
  maxTimestampSkewSeconds?: number;
}

export interface VerifyHttpRequestResult {
  canonicalRequest: string;
  proof: string;
}

export type VerifyHttpRequestNonceCheckInput = {
  agentDid: string;
  nonce: string;
  ttlMs?: number;
  nowMs?: number;
};

export type VerifyHttpRequestNonceCheckResult =
  | {
      accepted: true;
      seenAt?: number;
      expiresAt?: number;
    }
  | {
      accepted: false;
      reason: "replay";
      seenAt?: number;
      expiresAt?: number;
    };

export interface VerifyHttpRequestNonceChecker {
  tryAcceptNonce(
    input: VerifyHttpRequestNonceCheckInput,
  ):
    | VerifyHttpRequestNonceCheckResult
    | Promise<VerifyHttpRequestNonceCheckResult>;
}

export interface VerifyHttpRequestWithReplayProtectionInput
  extends VerifyHttpRequestInput {
  agentDid: string;
  nonceChecker: VerifyHttpRequestNonceChecker;
  nonceTtlMs?: number;
}
