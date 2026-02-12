import { describe, expect, it } from "vitest";
import {
  AitJwtError,
  AppError,
  addSeconds,
  CrlJwtError,
  createCrlCache,
  createNonceCache,
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
  DEFAULT_NONCE_TTL_MS,
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
  signCRL,
  signEd25519,
  signHttpRequest,
  verifyAIT,
  verifyCRL,
  verifyEd25519,
  verifyHttpRequest,
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

  it("exports CRL JWT helpers from package root", async () => {
    const keypair = await generateEd25519Keypair();
    const now = Math.floor(Date.now() / 1000);
    const token = await signCRL({
      claims: {
        iss: "https://registry.clawdentity.dev",
        jti: "01HF7YAT4TXP6AW5QNXA2Y9K43",
        iat: now,
        exp: now + 3600,
        revocations: [
          {
            jti: "01HF7YAT31JZHSMW1CG6Q6MHB7",
            agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            reason: "manual revoke",
            revokedAt: now,
          },
        ],
      },
      signerKid: "reg-crl-root",
      signerKeypair: keypair,
    });

    const verified = await verifyCRL({
      token,
      registryKeys: [
        {
          kid: "reg-crl-root",
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeEd25519KeypairBase64url(keypair).publicKey,
          },
        },
      ],
      expectedIssuer: "https://registry.clawdentity.dev",
    });

    expect(verified.revocations).toHaveLength(1);
    expect(CrlJwtError).toBeTypeOf("function");
  });

  it("exports HTTP signing helpers from package root", async () => {
    const keypair = await generateEd25519Keypair();
    const body = new TextEncoder().encode('{"ok":true}');
    const signed = await signHttpRequest({
      method: "POST",
      pathWithQuery: "/v1/messages?b=2&a=1",
      timestamp: "1739364000",
      nonce: "nonce_root_http",
      body,
      secretKey: keypair.secretKey,
    });

    const verified = await verifyHttpRequest({
      method: "POST",
      pathWithQuery: "/v1/messages?b=2&a=1",
      headers: signed.headers,
      body,
      publicKey: keypair.publicKey,
    });

    expect(verified.proof).toBe(signed.proof);
    expect(verified.canonicalRequest).toBe(signed.canonicalRequest);
  });

  it("exports nonce cache helpers from package root", () => {
    const now = 5_000;
    const cache = createNonceCache({
      ttlMs: 100,
      clock: () => now,
    });

    const first = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-root",
    });
    const second = cache.tryAcceptNonce({
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-root",
    });

    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({
      accepted: false,
      reason: "replay",
    });
    expect(DEFAULT_NONCE_TTL_MS).toBe(300000);
  });

  it("exports CRL cache helpers from package root", async () => {
    const cache = createCrlCache({
      fetchLatest: async () => ({
        iss: "https://registry.clawdentity.dev",
        jti: "01HF7YAT4TXP6AW5QNXA2Y9K43",
        iat: 1700100000,
        exp: 1700103600,
        revocations: [
          {
            jti: "01HF7YAT31JZHSMW1CG6Q6MHB7",
            agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            reason: "manual revoke",
            revokedAt: 1700100010,
          },
        ],
      }),
      clock: () => 1_000,
    });

    await expect(cache.isRevoked("01HF7YAT31JZHSMW1CG6Q6MHB7")).resolves.toBe(
      true,
    );
    await expect(cache.isRevoked("01HF7YAT5QJ4K3YVQJ6Q2F9M1N")).resolves.toBe(
      false,
    );
    expect(DEFAULT_CRL_REFRESH_INTERVAL_MS).toBe(300000);
    expect(DEFAULT_CRL_MAX_AGE_MS).toBe(900000);
  });
});
