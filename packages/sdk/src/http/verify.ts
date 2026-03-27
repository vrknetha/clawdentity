import { canonicalizeRequest } from "@clawdentity/protocol";
import {
  decodeEd25519SignatureBase64url,
  verifyEd25519,
} from "../crypto/ed25519.js";
import { AppError } from "../exceptions.js";
import {
  X_CLAW_BODY_SHA256,
  X_CLAW_NONCE,
  X_CLAW_PROOF,
  X_CLAW_TIMESTAMP,
} from "./constants.js";
import type {
  VerifyHttpRequestInput,
  VerifyHttpRequestNonceCheckResult,
  VerifyHttpRequestResult,
  VerifyHttpRequestWithReplayProtectionInput,
} from "./types.js";
import {
  ensureBodyBytes,
  ensurePublicKey,
  ensureString,
  hashBodySha256Base64url,
  normalizeSignatureHeaders,
  textEncoder,
} from "./utils.js";

const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;

function resolveNowMs(nowMs: number | undefined): number {
  const resolved = nowMs ?? Date.now();
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_INPUT",
      message: "nowMs must be a non-negative number",
      status: 400,
      details: {
        field: "nowMs",
        value: nowMs,
      },
    });
  }

  return resolved;
}

function resolveMaxTimestampSkewSeconds(
  maxTimestampSkewSeconds: number | undefined,
): number {
  const resolved =
    maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_INPUT",
      message: "maxTimestampSkewSeconds must be a positive number",
      status: 400,
      details: {
        field: "maxTimestampSkewSeconds",
        value: maxTimestampSkewSeconds,
      },
    });
  }

  return resolved;
}

function resolveNonceTtlMs(
  nonceTtlMs: number | undefined,
  maxTimestampSkewSeconds: number,
): number {
  const resolved = nonceTtlMs ?? maxTimestampSkewSeconds * 1000;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_INPUT",
      message: "nonceTtlMs must be a positive number",
      status: 400,
      details: {
        field: "nonceTtlMs",
        value: nonceTtlMs,
      },
    });
  }

  return resolved;
}

function parseUnixTimestamp(timestampHeader: string): number {
  if (!/^\d+$/.test(timestampHeader)) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_TIMESTAMP",
      message: "X-Claw-Timestamp must be a unix seconds integer",
      status: 401,
    });
  }

  const parsed = Number.parseInt(timestampHeader, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_TIMESTAMP",
      message: "X-Claw-Timestamp must be a unix seconds integer",
      status: 401,
    });
  }

  return parsed;
}

function assertTimestampWithinSkew(options: {
  nowMs: number;
  maxTimestampSkewSeconds: number;
  timestampSeconds: number;
}): void {
  const nowSeconds = Math.floor(options.nowMs / 1000);
  const skew = Math.abs(nowSeconds - options.timestampSeconds);
  if (skew > options.maxTimestampSkewSeconds) {
    throw new AppError({
      code: "HTTP_SIGNATURE_TIMESTAMP_SKEW",
      message: "X-Claw-Timestamp is outside the allowed skew window",
      status: 401,
      details: {
        maxTimestampSkewSeconds: options.maxTimestampSkewSeconds,
      },
    });
  }
}

function toErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return "unknown";
}

export async function verifyHttpRequest(
  input: VerifyHttpRequestInput,
): Promise<VerifyHttpRequestResult> {
  ensurePublicKey(input.publicKey);

  const method = ensureString(input.method, "method");
  const pathWithQuery = ensureString(input.pathWithQuery, "pathWithQuery");
  const headers = normalizeSignatureHeaders(input.headers);
  const body = ensureBodyBytes(input.body);
  const expectedBodyHash = await hashBodySha256Base64url(body);
  const nowMs = resolveNowMs(input.nowMs);
  const maxTimestampSkewSeconds = resolveMaxTimestampSkewSeconds(
    input.maxTimestampSkewSeconds,
  );

  if (headers[X_CLAW_BODY_SHA256] !== expectedBodyHash) {
    throw new AppError({
      code: "HTTP_SIGNATURE_BODY_HASH_MISMATCH",
      message: "Body hash does not match X-Claw-Body-SHA256 header",
      status: 401,
      details: {
        expectedBodyHash,
        receivedBodyHash: headers[X_CLAW_BODY_SHA256],
      },
    });
  }

  const timestampSeconds = parseUnixTimestamp(headers[X_CLAW_TIMESTAMP]);
  assertTimestampWithinSkew({
    nowMs,
    maxTimestampSkewSeconds,
    timestampSeconds,
  });

  const canonicalRequest = canonicalizeRequest({
    method,
    pathWithQuery,
    timestamp: headers[X_CLAW_TIMESTAMP],
    nonce: headers[X_CLAW_NONCE],
    bodyHash: headers[X_CLAW_BODY_SHA256],
  });

  let signature: Uint8Array;
  try {
    signature = decodeEd25519SignatureBase64url(headers[X_CLAW_PROOF]);
    if (signature.length !== 64) {
      throw new Error("invalid_signature_length");
    }
  } catch {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
      message: "X-Claw-Proof is not a valid base64url signature",
      status: 401,
      details: {
        header: X_CLAW_PROOF,
        reason: "invalid_base64url_or_signature_length",
      },
    });
  }

  const isValid = await verifyEd25519(
    signature,
    textEncoder.encode(canonicalRequest),
    input.publicKey,
  );

  if (!isValid) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
      message: "X-Claw-Proof verification failed",
      status: 401,
      details: {
        reason: "signature_mismatch",
      },
    });
  }

  return {
    canonicalRequest,
    proof: headers[X_CLAW_PROOF],
  };
}

export async function verifyHttpRequestWithReplayProtection(
  input: VerifyHttpRequestWithReplayProtectionInput,
): Promise<VerifyHttpRequestResult> {
  const verified = await verifyHttpRequest(input);
  const headers = normalizeSignatureHeaders(input.headers);
  const agentDid = ensureString(input.agentDid, "agentDid");
  const nowMs = resolveNowMs(input.nowMs);
  const maxTimestampSkewSeconds = resolveMaxTimestampSkewSeconds(
    input.maxTimestampSkewSeconds,
  );
  const nonceTtlMs = resolveNonceTtlMs(
    input.nonceTtlMs,
    maxTimestampSkewSeconds,
  );

  let nonceCheckResult: VerifyHttpRequestNonceCheckResult;
  try {
    nonceCheckResult = await input.nonceChecker.tryAcceptNonce({
      agentDid,
      nonce: headers[X_CLAW_NONCE],
      ttlMs: nonceTtlMs,
      nowMs,
    });
  } catch (error) {
    throw new AppError({
      code: "HTTP_SIGNATURE_NONCE_CHECK_FAILED",
      message: "Nonce replay check failed",
      status: 401,
      details: {
        reason: toErrorReason(error),
      },
    });
  }

  if (!nonceCheckResult.accepted) {
    throw new AppError({
      code: "HTTP_SIGNATURE_REPLAY_DETECTED",
      message: "Replay detected",
      status: 401,
      details: {
        reason: nonceCheckResult.reason,
      },
    });
  }

  return verified;
}
