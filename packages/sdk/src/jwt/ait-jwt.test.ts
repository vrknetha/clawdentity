import {
  type AitClaims,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "../crypto/ed25519.js";
import { signAIT, verifyAIT } from "./ait-jwt.js";

function makeClaims(overrides: Partial<AitClaims> = {}): AitClaims {
  const agentUlid = generateUlid(1700100000000);
  const ownerUlid = generateUlid(1700100001000);
  const now = Math.floor(Date.now() / 1000);

  return {
    iss: "https://registry.clawdentity.dev",
    sub: makeAgentDid(agentUlid),
    ownerDid: makeHumanDid(ownerUlid),
    name: "agent-jwt-01",
    framework: "openclaw",
    description: "AIT JWT test payload",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: encodeBase64url(
          Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        ),
      },
    },
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
    jti: generateUlid(1700100002000),
    ...overrides,
  };
}

describe("AIT JWT helpers", () => {
  it("signs and verifies an AIT with matching registry key + kid", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signAIT({
      claims,
      signerKid: "reg-key-1",
      signerKeypair: keypair,
    });

    const verified = await verifyAIT({
      token,
      registryKeys: [
        {
          kid: "reg-key-1",
          jwk: {
            kty: "OKP",
            crv: "Ed25519",
            x: encodeBase64url(keypair.publicKey),
          },
        },
      ],
      expectedIssuer: claims.iss,
    });

    expect(verified).toEqual(claims);
  });

  it("fails verification when issuer does not match expected issuer", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signAIT({
      claims,
      signerKid: "reg-key-1",
      signerKeypair: keypair,
    });

    await expect(
      verifyAIT({
        token,
        registryKeys: [
          {
            kid: "reg-key-1",
            jwk: {
              kty: "OKP",
              crv: "Ed25519",
              x: encodeBase64url(keypair.publicKey),
            },
          },
        ],
        expectedIssuer: "https://wrong-issuer.example",
      }),
    ).rejects.toThrow();
  });

  it("fails verification when token kid cannot be found in registry key set", async () => {
    const keypair = await generateEd25519Keypair();
    const claims = makeClaims();
    const token = await signAIT({
      claims,
      signerKid: "reg-key-1",
      signerKeypair: keypair,
    });

    await expect(
      verifyAIT({
        token,
        registryKeys: [
          {
            kid: "reg-key-2",
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
});
