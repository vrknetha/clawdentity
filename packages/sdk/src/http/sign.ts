import { canonicalizeRequest } from "@clawdentity/protocol";
import {
  encodeEd25519SignatureBase64url,
  signEd25519,
} from "../crypto/ed25519.js";
import {
  X_CLAW_BODY_SHA256,
  X_CLAW_NONCE,
  X_CLAW_PROOF,
  X_CLAW_TIMESTAMP,
} from "./constants.js";
import type { SignHttpRequestInput, SignHttpRequestResult } from "./types.js";
import {
  ensureBodyBytes,
  ensureSecretKey,
  ensureString,
  hashBodySha256Base64url,
  textEncoder,
} from "./utils.js";

export async function signHttpRequest(
  input: SignHttpRequestInput,
): Promise<SignHttpRequestResult> {
  ensureSecretKey(input.secretKey);

  const method = ensureString(input.method, "method");
  const pathWithQuery = ensureString(input.pathWithQuery, "pathWithQuery");
  const timestamp = ensureString(input.timestamp, "timestamp");
  const nonce = ensureString(input.nonce, "nonce");
  const body = ensureBodyBytes(input.body);
  const bodyHash = await hashBodySha256Base64url(body);

  const canonicalRequest = canonicalizeRequest({
    method,
    pathWithQuery,
    timestamp,
    nonce,
    bodyHash,
  });

  const signature = await signEd25519(
    textEncoder.encode(canonicalRequest),
    input.secretKey,
  );
  const proof = encodeEd25519SignatureBase64url(signature);

  return {
    canonicalRequest,
    proof,
    headers: {
      [X_CLAW_TIMESTAMP]: timestamp,
      [X_CLAW_NONCE]: nonce,
      [X_CLAW_BODY_SHA256]: bodyHash,
      [X_CLAW_PROOF]: proof,
    },
  };
}
