import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import { x25519 } from "@noble/curves/ed25519.js";

const X25519_KEY_BYTES = 32;

export type X25519KeypairBytes = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export type X25519KeypairBase64url = {
  publicKey: string;
  secretKey: string;
};

function assertX25519KeyLength(key: Uint8Array, label: string): void {
  if (key.length !== X25519_KEY_BYTES) {
    throw new TypeError(`${label} must be ${X25519_KEY_BYTES} bytes`);
  }
}

export function generateX25519Keypair(): X25519KeypairBytes {
  const keypair = x25519.keygen();
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
  };
}

export function deriveX25519PublicKey(secretKey: Uint8Array): Uint8Array {
  assertX25519KeyLength(secretKey, "secretKey");
  return x25519.getPublicKey(secretKey);
}

export function deriveX25519SharedSecret(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array {
  assertX25519KeyLength(secretKey, "secretKey");
  assertX25519KeyLength(peerPublicKey, "peerPublicKey");
  return x25519.getSharedSecret(secretKey, peerPublicKey);
}

export function encodeX25519KeypairBase64url(
  keypair: X25519KeypairBytes,
): X25519KeypairBase64url {
  return {
    publicKey: encodeBase64url(keypair.publicKey),
    secretKey: encodeBase64url(keypair.secretKey),
  };
}

export function decodeX25519KeypairBase64url(
  keypair: X25519KeypairBase64url,
): X25519KeypairBytes {
  return {
    publicKey: decodeBase64url(keypair.publicKey),
    secretKey: decodeBase64url(keypair.secretKey),
  };
}
