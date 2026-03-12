import {
  decodeBase64url,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
} from "@clawdentity/protocol";
import { importJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "../crypto/ed25519.js";
import { type CrlClaims, signCRL, verifyCRL } from "./crl-jwt.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function makeClaims(overrides: Partial<CrlClaims> = {}): CrlClaims {
  const now = Math.floor(Date.now() / 1000);
  const agentId = generateUlid(1700105002000);
  const authority = "registry.clawdentity.dev";

  return {
    iss: `https://${authority}`,
    jti: generateUlid(1700105000000),
    iat: now,
    exp: now + 3600,
    revocations: [
      {
        jti: generateUlid(1700105001000),
        agentDid: makeAgentDid(authority, agentId),
        reason: "compromised key",
        revokedAt: now,
      },
    ],
    ...overrides,
  };
}

function patchTokenSegment(
  token: string,
  segmentIndex: 0 | 1,
  patch: (payload: Record<string, unknown>) => Record<string, unknown>,
): string {
  const parts = token.split(".");
  const bytes = decodeBase64url(parts[segmentIndex]);
  const parsed = JSON.parse(textDecoder.decode(bytes));
  const patched = patch(parsed);
  const encoded = encodeBase64url(textEncoder.encode(JSON.stringify(patched)));
  parts[segmentIndex] = encoded;
  return parts.join(".");
}

function swapSignature(token: string): string {
  const parts = token.split(".");
  parts[2] = "A".repeat(parts[2].length);
  return parts.join(".");
}

describe("CRL JWT helpers", () => {
  it("signs and verifies a valid CRL token", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signCRL({
      claims,
      signerKid: "reg-crl-1",
      signerKeypair: keypair,
    });

    const verified = await verifyCRL({
      token,
      registryKeys: [
        {
          kid: "reg-crl-1",
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeBase64url(keypair.publicKey),
          },
        },
      ],
      expectedIssuer: "https://registry.clawdentity.dev",
    });

    expect(verified.jti).toBe(claims.jti);
    expect(verified.revocations).toHaveLength(1);
  });

  it("rejects a payload change after signing", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signCRL({
      claims,
      signerKid: "reg-crl-1",
      signerKeypair: keypair,
    });

    const tampered = patchTokenSegment(token, 1, (payload) => {
      const base = payload as Record<string, unknown> & {
        revocations?: unknown[];
      };
      const existing = Array.isArray(base.revocations) ? base.revocations : [];
      return {
        ...base,
        revocations: [...existing, "tampered"],
      };
    });

    await expect(
      verifyCRL({
        token: tampered,
        registryKeys: [
          {
            kid: "reg-crl-1",
            jwk: {
              kty: "OKP",
              crv: "Ed25519",
              x: encodeBase64url(keypair.publicKey),
            },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("rejects a header kid tampering attempt", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signCRL({
      claims,
      signerKid: "reg-crl-1",
      signerKeypair: keypair,
    });

    const tampered = patchTokenSegment(token, 0, (header) => ({
      ...header,
      kid: "tamper-kid",
    }));

    await expect(
      verifyCRL({
        token: tampered,
        registryKeys: [
          {
            kid: "reg-crl-1",
            jwk: {
              kty: "OKP",
              crv: "Ed25519",
              x: encodeBase64url(keypair.publicKey),
            },
          },
        ],
      }),
    ).rejects.toThrow(/kid/i);
  });

  it("rejects tampered signature bytes", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signCRL({
      claims,
      signerKid: "reg-crl-1",
      signerKeypair: keypair,
    });

    const tampered = swapSignature(token);

    await expect(
      verifyCRL({
        token: tampered,
        registryKeys: [
          {
            kid: "reg-crl-1",
            jwk: {
              kty: "OKP",
              crv: "Ed25519",
              x: encodeBase64url(keypair.publicKey),
            },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("rejects schema-invalid but correctly signed payloads", async () => {
    const keypair = await generateEd25519Keypair();
    const now = Math.floor(Date.now() / 1000);
    const encodedKeypair = encodeEd25519KeypairBase64url(keypair);
    const privateKey = await importJWK(
      {
        kty: "OKP",
        crv: "Ed25519",
        x: encodedKeypair.publicKey,
        d: encodedKeypair.secretKey,
      },
      "EdDSA",
    );
    const token = await new SignJWT({
      iss: "https://registry.clawdentity.dev",
      jti: generateUlid(1700105000000),
      iat: now,
      exp: now + 3600,
      revocations: [],
    })
      .setProtectedHeader({
        alg: "EdDSA",
        typ: "CRL",
        kid: "reg-crl-1",
      })
      .sign(privateKey);

    await expect(
      verifyCRL({
        token,
        registryKeys: [
          {
            kid: "reg-crl-1",
            jwk: {
              kty: "OKP",
              crv: "Ed25519",
              x: encodeBase64url(keypair.publicKey),
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CRL_CLAIMS",
    });
  });

  it("rejects invalid CRL claims before signing", async () => {
    const keypair = await generateEd25519Keypair();
    const now = Math.floor(Date.now() / 1000);

    await expect(
      signCRL({
        claims: {
          iss: "https://registry.clawdentity.dev",
          jti: generateUlid(1700105000000),
          iat: now,
          exp: now + 3600,
          revocations: [],
        } as unknown as CrlClaims,
        signerKid: "reg-crl-1",
        signerKeypair: keypair,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CRL_CLAIMS",
    });
  });
});
