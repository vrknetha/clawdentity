import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import * as ed25519 from "@noble/ed25519";

export type Ed25519KeypairBytes = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export type Ed25519KeypairBase64url = {
  publicKey: string;
  secretKey: string;
};

export async function generateEd25519Keypair(): Promise<Ed25519KeypairBytes> {
  const keypair = await ed25519.keygenAsync();
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
  };
}

export async function signEd25519(
  message: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  return ed25519.signAsync(message, secretKey);
}

export async function deriveEd25519PublicKey(
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  return ed25519.getPublicKeyAsync(secretKey);
}

export async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  return ed25519.verifyAsync(signature, message, publicKey);
}

export function encodeEd25519KeypairBase64url(
  keypair: Ed25519KeypairBytes,
): Ed25519KeypairBase64url {
  return {
    publicKey: encodeBase64url(keypair.publicKey),
    secretKey: encodeBase64url(keypair.secretKey),
  };
}

export function decodeEd25519KeypairBase64url(
  keypair: Ed25519KeypairBase64url,
): Ed25519KeypairBytes {
  return {
    publicKey: decodeBase64url(keypair.publicKey),
    secretKey: decodeBase64url(keypair.secretKey),
  };
}

export function encodeEd25519SignatureBase64url(signature: Uint8Array): string {
  return encodeBase64url(signature);
}

export function decodeEd25519SignatureBase64url(signature: string): Uint8Array {
  return decodeBase64url(signature);
}
