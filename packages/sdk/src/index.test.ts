import { describe, expect, it } from "vitest";
import {
  AppError,
  addSeconds,
  decodeEd25519KeypairBase64url,
  decodeEd25519SignatureBase64url,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  parseRegistryConfig,
  REQUEST_ID_HEADER,
  resolveRequestId,
  SDK_VERSION,
  signEd25519,
  verifyEd25519,
} from "./index.js";

describe("sdk", () => {
  it("exports SDK_VERSION", () => {
    expect(SDK_VERSION).toBe("0.0.0");
  });

  it("exports shared helpers", () => {
    expect(addSeconds("2026-01-01T00:00:00.000Z", 10)).toBe(
      "2026-01-01T00:00:10.000Z",
    );
    expect(resolveRequestId("valid-id-123")).toBe("valid-id-123");
    expect(parseRegistryConfig({ ENVIRONMENT: "test" }).ENVIRONMENT).toBe(
      "test",
    );
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
    expect(AppError).toBeTypeOf("function");
  });

  it("exports Ed25519 helpers from package root", async () => {
    const keypair = await generateEd25519Keypair();
    const message = new TextEncoder().encode("root-export-crypto-test");
    const signature = await signEd25519(message, keypair.secretKey);

    expect(await verifyEd25519(signature, message, keypair.publicKey)).toBe(
      true,
    );

    const encodedKeypair = encodeEd25519KeypairBase64url(keypair);
    const decodedKeypair = decodeEd25519KeypairBase64url(encodedKeypair);
    expect(Array.from(decodedKeypair.publicKey)).toEqual(
      Array.from(keypair.publicKey),
    );

    const encodedSignature = encodeEd25519SignatureBase64url(signature);
    const decodedSignature = decodeEd25519SignatureBase64url(encodedSignature);
    expect(Array.from(decodedSignature)).toEqual(Array.from(signature));
  });
});
