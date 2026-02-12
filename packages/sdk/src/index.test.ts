import { describe, expect, it } from "vitest";
import {
  AitJwtError,
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
  signAIT,
  signEd25519,
  verifyAIT,
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

  it("exports AIT JWT helpers from package root", async () => {
    const keypair = await generateEd25519Keypair();
    const token = await signAIT({
      claims: {
        iss: "https://registry.clawdentity.dev",
        sub: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        ownerDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        name: "jwt-root-test",
        framework: "openclaw",
        cnf: {
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeEd25519KeypairBase64url(keypair).publicKey,
          },
        },
        iat: 1700100000,
        nbf: 1700099995,
        exp: 4700100000,
        jti: "01HF7YAT4TXP6AW5QNXA2Y9K43",
      },
      signerKid: "reg-key-root",
      signerKeypair: keypair,
    });

    const verified = await verifyAIT({
      token,
      registryKeys: [
        {
          kid: "reg-key-root",
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeEd25519KeypairBase64url(keypair).publicKey,
          },
        },
      ],
      expectedIssuer: "https://registry.clawdentity.dev",
    });

    expect(verified.name).toBe("jwt-root-test");
    expect(AitJwtError).toBeTypeOf("function");
  });
});
