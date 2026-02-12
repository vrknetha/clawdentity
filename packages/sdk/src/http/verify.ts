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
  VerifyHttpRequestResult,
} from "./types.js";
import {
  ensureBodyBytes,
  ensurePublicKey,
  ensureString,
  hashBodySha256Base64url,
  normalizeSignatureHeaders,
  textEncoder,
} from "./utils.js";

export async function verifyHttpRequest(
  input: VerifyHttpRequestInput,
): Promise<VerifyHttpRequestResult> {
  ensurePublicKey(input.publicKey);

  const method = ensureString(input.method, "method");
  const pathWithQuery = ensureString(input.pathWithQuery, "pathWithQuery");
  const headers = normalizeSignatureHeaders(input.headers);
  const body = ensureBodyBytes(input.body);
  const expectedBodyHash = await hashBodySha256Base64url(body);

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
  } catch {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
      message: "X-Claw-Proof is not a valid base64url signature",
      status: 401,
      details: {
        header: X_CLAW_PROOF,
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
