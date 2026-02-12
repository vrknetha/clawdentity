import { encodeBase64url } from "@clawdentity/protocol";
import { AppError } from "../exceptions.js";
import {
  X_CLAW_BODY_SHA256,
  X_CLAW_NONCE,
  X_CLAW_PROOF,
  X_CLAW_TIMESTAMP,
} from "./constants.js";
import type { ClawSignatureHeaders } from "./types.js";

export const textEncoder = new TextEncoder();
const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SECRET_KEY_LENGTH = 32;

type SubtleCryptoLike = {
  digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
};

type CryptoLike = {
  subtle?: SubtleCryptoLike;
};

function getCrypto(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

export function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_INPUT",
      message: "Input must be a non-empty string",
      status: 400,
      details: {
        field: label,
      },
    });
  }

  return value;
}

export function ensureBodyBytes(body: Uint8Array | undefined): Uint8Array {
  if (body === undefined) {
    return new Uint8Array();
  }

  if (!(body instanceof Uint8Array)) {
    throw new AppError({
      code: "HTTP_SIGNATURE_INVALID_INPUT",
      message: "body must be a Uint8Array when provided",
      status: 400,
      details: {
        field: "body",
      },
    });
  }

  return body;
}

export function ensureSecretKey(key: Uint8Array): void {
  if (
    !(key instanceof Uint8Array) ||
    key.length !== ED25519_SECRET_KEY_LENGTH
  ) {
    throw new AppError({
      code: "HTTP_SIGNATURE_MISSING_SECRET",
      message: "Secret key is required to sign HTTP requests",
      status: 500,
      details: {
        keyLength: key instanceof Uint8Array ? key.length : null,
        expectedKeyLength: ED25519_SECRET_KEY_LENGTH,
      },
    });
  }
}

export function ensurePublicKey(key: Uint8Array): void {
  if (
    !(key instanceof Uint8Array) ||
    key.length !== ED25519_PUBLIC_KEY_LENGTH
  ) {
    throw new AppError({
      code: "HTTP_SIGNATURE_MISSING_PUBLIC",
      message: "Public key is required to verify HTTP requests",
      status: 500,
      details: {
        keyLength: key instanceof Uint8Array ? key.length : null,
        expectedKeyLength: ED25519_PUBLIC_KEY_LENGTH,
      },
    });
  }
}

export async function hashBodySha256Base64url(
  body: Uint8Array,
): Promise<string> {
  const cryptoObject = getCrypto();

  if (
    typeof cryptoObject !== "object" ||
    typeof cryptoObject?.subtle !== "object" ||
    typeof cryptoObject?.subtle?.digest !== "function"
  ) {
    throw new AppError({
      code: "HTTP_SIGNATURE_CRYPTO_UNAVAILABLE",
      message: "Web Crypto API is required for HTTP signing",
      status: 500,
      details: {
        runtime: typeof cryptoObject,
      },
    });
  }

  const digest = await cryptoObject.subtle.digest("SHA-256", body);
  return encodeBase64url(new Uint8Array(digest));
}

function readHeader(
  headers: Record<string, string | undefined>,
  headerName: string,
): string | undefined {
  if (headerName in headers) {
    return headers[headerName];
  }

  const normalizedName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      return value;
    }
  }

  return undefined;
}

export function normalizeSignatureHeaders(
  headers: Record<string, string | undefined>,
): ClawSignatureHeaders {
  return {
    [X_CLAW_TIMESTAMP]: ensureString(
      readHeader(headers, X_CLAW_TIMESTAMP),
      X_CLAW_TIMESTAMP,
    ),
    [X_CLAW_NONCE]: ensureString(
      readHeader(headers, X_CLAW_NONCE),
      X_CLAW_NONCE,
    ),
    [X_CLAW_BODY_SHA256]: ensureString(
      readHeader(headers, X_CLAW_BODY_SHA256),
      X_CLAW_BODY_SHA256,
    ),
    [X_CLAW_PROOF]: ensureString(
      readHeader(headers, X_CLAW_PROOF),
      X_CLAW_PROOF,
    ),
  };
}
