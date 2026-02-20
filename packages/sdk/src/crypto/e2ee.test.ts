import { describe, expect, it } from "vitest";
import {
  decodeCanonicalJson,
  decryptXChaCha20Poly1305,
  encodeCanonicalJson,
  encryptXChaCha20Poly1305,
} from "./e2ee.js";

function bytes(length: number, start = 1): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (index + start) % 256);
}

describe("e2ee crypto helpers", () => {
  it("encrypts and decrypts payloads with AAD", () => {
    const key = bytes(32, 4);
    const nonce = bytes(24, 9);
    const payload = { message: "hello", n: 1 };
    const aad = new TextEncoder().encode("did:claw:agent:alice|bob");
    const plaintext = encodeCanonicalJson(payload);
    const ciphertext = encryptXChaCha20Poly1305({
      key,
      nonce,
      plaintext,
      aad,
    });
    const decrypted = decryptXChaCha20Poly1305({
      key,
      nonce,
      ciphertext,
      aad,
    });
    expect(decodeCanonicalJson(decrypted)).toEqual(payload);
  });

  it("fails decryption when AAD differs", () => {
    const key = bytes(32, 4);
    const nonce = bytes(24, 9);
    const payload = { message: "hello", n: 1 };
    const ciphertext = encryptXChaCha20Poly1305({
      key,
      nonce,
      plaintext: encodeCanonicalJson(payload),
      aad: new TextEncoder().encode("aad-one"),
    });

    expect(() =>
      decryptXChaCha20Poly1305({
        key,
        nonce,
        ciphertext,
        aad: new TextEncoder().encode("aad-two"),
      }),
    ).toThrowError();
  });
});
