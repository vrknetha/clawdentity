import { generateUlid } from "@clawdentity/protocol";
import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
  signAIT,
  signCRL,
  signHttpRequest,
} from "@clawdentity/sdk";
import { buildTestAitClaims } from "@clawdentity/sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { parseProxyConfig } from "../config.js";
import { createInMemoryProxyTrustStore } from "../proxy-trust-store.js";
import { createProxyApp } from "../server.js";
import {
  BODY_JSON,
  ISSUER,
  KNOWN_PEER_DID,
  NOW_MS,
  NOW_SECONDS,
  resolveRequestUrl,
} from "./helpers.js";

type RotationCase = {
  aitSignedBy: "old" | "new";
  crlSignedBy: "old" | "new";
  nonce: string;
};

async function runRotationCase(input: RotationCase) {
  const oldKid = "registry-old-kid";
  const newKid = "registry-new-kid";
  const oldRegistryKeypair = await generateEd25519Keypair();
  const newRegistryKeypair = await generateEd25519Keypair();
  const agentKeypair = await generateEd25519Keypair();
  const encodedOldRegistry = encodeEd25519KeypairBase64url(oldRegistryKeypair);
  const encodedNewRegistry = encodeEd25519KeypairBase64url(newRegistryKeypair);
  const encodedAgent = encodeEd25519KeypairBase64url(agentKeypair);

  const claims = buildTestAitClaims({
    publicKeyX: encodedAgent.publicKey,
    issuer: ISSUER,
    nowSeconds: NOW_SECONDS - 10,
    ttlSeconds: 610,
    nbfSkewSeconds: 0,
    seedMs: NOW_MS,
  });

  const signerByKey = {
    old: {
      kid: oldKid,
      keypair: oldRegistryKeypair,
    },
    new: {
      kid: newKid,
      keypair: newRegistryKeypair,
    },
  } as const;

  const aitSigner = signerByKey[input.aitSignedBy];
  const crlSigner = signerByKey[input.crlSignedBy];

  const ait = await signAIT({
    claims,
    signerKid: aitSigner.kid,
    signerKeypair: aitSigner.keypair,
  });
  const crl = await signCRL({
    claims: {
      iss: ISSUER,
      jti: generateUlid(NOW_MS + 70),
      iat: NOW_SECONDS - 10,
      exp: NOW_SECONDS + 600,
      revocations: [
        {
          jti: generateUlid(NOW_MS + 80),
          agentDid: claims.sub,
          revokedAt: NOW_SECONDS - 5,
          reason: "manual revoke",
        },
      ],
    },
    signerKid: crlSigner.kid,
    signerKeypair: crlSigner.keypair,
  });

  let keyFetchCount = 0;
  const fetchMock = vi.fn(async (requestInput: unknown): Promise<Response> => {
    const url = resolveRequestUrl(requestInput);

    if (url.endsWith("/.well-known/claw-keys.json")) {
      keyFetchCount += 1;
      const key =
        keyFetchCount === 1
          ? {
              kid: oldKid,
              alg: "EdDSA",
              crv: "Ed25519",
              x: encodedOldRegistry.publicKey,
              status: "active",
            }
          : {
              kid: newKid,
              alg: "EdDSA",
              crv: "Ed25519",
              x: encodedNewRegistry.publicKey,
              status: "active",
            };
      return new Response(
        JSON.stringify({
          keys: [key],
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/v1/crl")) {
      return new Response(
        JSON.stringify({
          crl,
        }),
        { status: 200 },
      );
    }

    return new Response("not found", { status: 404 });
  });

  const trustStore = createInMemoryProxyTrustStore();
  await trustStore.upsertPair({
    initiatorAgentDid: claims.sub,
    responderAgentDid: KNOWN_PEER_DID,
  });

  const app = createProxyApp({
    config: parseProxyConfig({
      REGISTRY_URL: ISSUER,
    }),
    trustStore,
    auth: {
      fetchImpl: fetchMock as typeof fetch,
      clock: () => NOW_MS,
    },
    registerRoutes: (nextApp) => {
      nextApp.post("/protected", (c) => c.json({ ok: true }));
    },
  });

  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: "/protected",
    timestamp: String(NOW_SECONDS),
    nonce: input.nonce,
    body: new TextEncoder().encode(BODY_JSON),
    secretKey: agentKeypair.secretKey,
  });
  const response = await app.request("/protected", {
    method: "POST",
    headers: {
      authorization: `Claw ${ait}`,
      "content-type": "application/json",
      ...signed.headers,
    },
    body: BODY_JSON,
  });

  return {
    keyFetchCount,
    response,
  };
}

describe("proxy auth middleware", () => {
  it("refreshes keyset and accepts valid AIT after registry key rotation", async () => {
    const { keyFetchCount, response } = await runRotationCase({
      aitSignedBy: "new",
      crlSignedBy: "new",
      nonce: "nonce-rotation",
    });

    expect(response.status).toBe(200);
    expect(keyFetchCount).toBe(2);
  });

  it("refreshes keyset and verifies CRL after registry CRL key rotation", async () => {
    const { keyFetchCount, response } = await runRotationCase({
      aitSignedBy: "old",
      crlSignedBy: "new",
      nonce: "nonce-crl-rotation",
    });

    expect(response.status).toBe(200);
    expect(keyFetchCount).toBe(2);
  });
});
