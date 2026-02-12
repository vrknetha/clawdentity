import { ProtocolParseError } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  decodeEd25519KeypairBase64url,
  decodeEd25519SignatureBase64url,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  signEd25519,
  verifyEd25519,
} from "./ed25519.js";

const encoder = new TextEncoder();

describe("ed25519 crypto helpers", () => {
  it("generates keypairs with expected key lengths", async () => {
    const keypair = await generateEd25519Keypair();

    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey).toHaveLength(32);
    expect(keypair.secretKey).toHaveLength(32);
  });

  it("signs and verifies successfully with matching message and keypair", async () => {
    const keypair = await generateEd25519Keypair();
    const message = encoder.encode("t03-happy-path");

    const signature = await signEd25519(message, keypair.secretKey);
    const isValid = await verifyEd25519(signature, message, keypair.publicKey);

    expect(isValid).toBe(true);
  });

  it("fails verification with the wrong message", async () => {
    const keypair = await generateEd25519Keypair();
    const message = encoder.encode("t03-original-message");
    const wrongMessage = encoder.encode("t03-tampered-message");
    const signature = await signEd25519(message, keypair.secretKey);

    const isValid = await verifyEd25519(
      signature,
      wrongMessage,
      keypair.publicKey,
    );

    expect(isValid).toBe(false);
  });

  it("fails verification with a tampered signature", async () => {
    const keypair = await generateEd25519Keypair();
    const message = encoder.encode("t03-signature-tamper");
    const signature = await signEd25519(message, keypair.secretKey);
    const tamperedSignature = Uint8Array.from(signature);
    tamperedSignature[0] ^= 0xff;

    const isValid = await verifyEd25519(
      tamperedSignature,
      message,
      keypair.publicKey,
    );

    expect(isValid).toBe(false);
  });

  it("fails verification with a different public key", async () => {
    const keypair = await generateEd25519Keypair();
    const otherKeypair = await generateEd25519Keypair();
    const message = encoder.encode("t03-wrong-public-key");
    const signature = await signEd25519(message, keypair.secretKey);

    const isValid = await verifyEd25519(
      signature,
      message,
      otherKeypair.publicKey,
    );

    expect(isValid).toBe(false);
  });

  it("roundtrips keypairs and signatures through base64url wrappers", async () => {
    const keypair = await generateEd25519Keypair();
    const message = encoder.encode("t03-base64url-roundtrip");
    const signature = await signEd25519(message, keypair.secretKey);

    const encodedKeypair = encodeEd25519KeypairBase64url(keypair);
    const decodedKeypair = decodeEd25519KeypairBase64url(encodedKeypair);

    expect(Array.from(decodedKeypair.publicKey)).toEqual(
      Array.from(keypair.publicKey),
    );
    expect(Array.from(decodedKeypair.secretKey)).toEqual(
      Array.from(keypair.secretKey),
    );

    const encodedSignature = encodeEd25519SignatureBase64url(signature);
    const decodedSignature = decodeEd25519SignatureBase64url(encodedSignature);
    expect(Array.from(decodedSignature)).toEqual(Array.from(signature));
  });

  it("throws protocol parse errors when decoding invalid base64url signature", () => {
    try {
      decodeEd25519SignatureBase64url("invalid+base64url");
      throw new Error("expected decode to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_BASE64URL");
    }
  });
});
