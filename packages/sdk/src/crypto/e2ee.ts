import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

const XCHACHA20POLY1305_KEY_BYTES = 32;
const XCHACHA20POLY1305_NONCE_BYTES = 24;

function assertLength(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) {
    throw new TypeError(`${label} must be ${length} bytes`);
  }
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeCanonicalJson<T = unknown>(value: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(value)) as T;
}

export function encryptXChaCha20Poly1305(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  plaintext: Uint8Array;
  aad?: Uint8Array;
}): Uint8Array {
  assertLength(input.key, XCHACHA20POLY1305_KEY_BYTES, "key");
  assertLength(input.nonce, XCHACHA20POLY1305_NONCE_BYTES, "nonce");
  return xchacha20poly1305(input.key, input.nonce, input.aad).encrypt(
    input.plaintext,
  );
}

export function decryptXChaCha20Poly1305(input: {
  key: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  aad?: Uint8Array;
}): Uint8Array {
  assertLength(input.key, XCHACHA20POLY1305_KEY_BYTES, "key");
  assertLength(input.nonce, XCHACHA20POLY1305_NONCE_BYTES, "nonce");
  return xchacha20poly1305(input.key, input.nonce, input.aad).decrypt(
    input.ciphertext,
  );
}
