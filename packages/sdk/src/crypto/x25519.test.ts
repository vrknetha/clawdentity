import { describe, expect, it } from "vitest";
import {
  decodeX25519KeypairBase64url,
  deriveX25519PublicKey,
  deriveX25519SharedSecret,
  encodeX25519KeypairBase64url,
  generateX25519Keypair,
} from "./x25519.js";

describe("x25519 crypto helpers", () => {
  it("generates keypairs with expected key lengths", () => {
    const keypair = generateX25519Keypair();
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  it("derives matching shared secrets for both peers", () => {
    const alice = generateX25519Keypair();
    const bob = generateX25519Keypair();
    const aliceShared = deriveX25519SharedSecret(
      alice.secretKey,
      bob.publicKey,
    );
    const bobShared = deriveX25519SharedSecret(bob.secretKey, alice.publicKey);
    expect(Array.from(aliceShared)).toEqual(Array.from(bobShared));
  });

  it("derives public key from secret key", () => {
    const keypair = generateX25519Keypair();
    const derived = deriveX25519PublicKey(keypair.secretKey);
    expect(Array.from(derived)).toEqual(Array.from(keypair.publicKey));
  });

  it("roundtrips keypairs through base64url wrappers", () => {
    const keypair = generateX25519Keypair();
    const encoded = encodeX25519KeypairBase64url(keypair);
    const decoded = decodeX25519KeypairBase64url(encoded);
    expect(Array.from(decoded.publicKey)).toEqual(
      Array.from(keypair.publicKey),
    );
    expect(Array.from(decoded.secretKey)).toEqual(
      Array.from(keypair.secretKey),
    );
  });
});
