import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "../crypto/ed25519.js";
import { signHttpRequest } from "./sign.js";
import { verifyHttpRequest } from "./verify.js";

const textEncoder = new TextEncoder();
const NOW_MS = 1_739_364_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

async function makeSignedFixture(input?: {
  timestamp?: string;
  nonce?: string;
  method?: string;
  pathWithQuery?: string;
}) {
  const keypair = await generateEd25519Keypair();
  const body = textEncoder.encode('{"hello":"world"}');
  const method = input?.method ?? "POST";
  const pathWithQuery = input?.pathWithQuery ?? "/v1/messages?b=2&a=1";
  const timestamp = input?.timestamp ?? String(NOW_SECONDS);
  const nonce = input?.nonce ?? "nonce_abc123";
  const signed = await signHttpRequest({
    method,
    pathWithQuery,
    timestamp,
    nonce,
    body,
    secretKey: keypair.secretKey,
  });

  return { keypair, body, signed, method, pathWithQuery };
}

describe("verifyHttpRequest", () => {
  it("verifies a signed request successfully", async () => {
    const { keypair, body, signed, method, pathWithQuery } =
      await makeSignedFixture();

    const verified = await verifyHttpRequest({
      method,
      pathWithQuery,
      headers: signed.headers,
      body,
      publicKey: keypair.publicKey,
      nowMs: NOW_MS,
    });

    expect(verified.proof).toBe(signed.proof);
    expect(verified.canonicalRequest).toBe(signed.canonicalRequest);
  });

  it("fails verification when method is altered", async () => {
    const { keypair, body, signed, pathWithQuery } = await makeSignedFixture();

    await expect(
      verifyHttpRequest({
        method: "PATCH",
        pathWithQuery,
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
    });
  });

  it("fails verification when path is altered", async () => {
    const { keypair, body, signed } = await makeSignedFixture();

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?a=1&b=2",
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
    });
  });

  it("fails verification when body is altered", async () => {
    const { keypair, signed } = await makeSignedFixture();
    const alteredBody = textEncoder.encode('{"hello":"tampered"}');

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body: alteredBody,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_BODY_HASH_MISMATCH",
    });
  });

  it("fails verification when timestamp header is malformed", async () => {
    const { keypair, body, signed } = await makeSignedFixture();
    const tamperedHeaders = {
      ...signed.headers,
      "X-Claw-Timestamp": `${NOW_SECONDS}.5`,
    };

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: tamperedHeaders,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_INVALID_TIMESTAMP",
    });
  });

  it("fails verification when proof decodes to non-64-byte signature", async () => {
    const { keypair, body, signed } = await makeSignedFixture();
    const tamperedHeaders = {
      ...signed.headers,
      "X-Claw-Proof": "AA",
    };

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: tamperedHeaders,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
      status: 401,
      details: {
        reason: "invalid_base64url_or_signature_length",
      },
    });
  });

  it("rejects wrong-length public keys", async () => {
    const { body, signed } = await makeSignedFixture();

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body,
        publicKey: new Uint8Array([1]),
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_MISSING_PUBLIC",
      details: {
        keyLength: 1,
        expectedKeyLength: 32,
      },
    });
  });

  it("rejects stale timestamps beyond max skew", async () => {
    const { keypair, body, signed, method, pathWithQuery } =
      await makeSignedFixture({
        timestamp: String(NOW_SECONDS - 301),
      });

    await expect(
      verifyHttpRequest({
        method,
        pathWithQuery,
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_TIMESTAMP_SKEW",
    });
  });

  it("rejects future timestamps beyond max skew", async () => {
    const { keypair, body, signed, method, pathWithQuery } =
      await makeSignedFixture({
        timestamp: String(NOW_SECONDS + 301),
      });

    await expect(
      verifyHttpRequest({
        method,
        pathWithQuery,
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_TIMESTAMP_SKEW",
    });
  });

  it("uses injected nowMs to keep freshness checks deterministic", async () => {
    const deterministicNowMs = NOW_MS + 120_000;
    const deterministicNowSeconds = Math.floor(deterministicNowMs / 1000);
    const { keypair, body, signed, method, pathWithQuery } =
      await makeSignedFixture({
        timestamp: String(deterministicNowSeconds - 250),
      });

    await expect(
      verifyHttpRequest({
        method,
        pathWithQuery,
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        nowMs: deterministicNowMs,
      }),
    ).resolves.toMatchObject({
      proof: signed.proof,
    });
  });
});
