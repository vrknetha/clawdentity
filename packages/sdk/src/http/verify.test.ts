import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "../crypto/ed25519.js";
import { signHttpRequest } from "./sign.js";
import { verifyHttpRequest } from "./verify.js";

const textEncoder = new TextEncoder();

async function makeSignedFixture() {
  const keypair = await generateEd25519Keypair();
  const body = textEncoder.encode('{"hello":"world"}');
  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: "/v1/messages?b=2&a=1",
    timestamp: "1739364000",
    nonce: "nonce_abc123",
    body,
    secretKey: keypair.secretKey,
  });

  return { keypair, body, signed };
}

describe("verifyHttpRequest", () => {
  it("verifies a signed request successfully", async () => {
    const { keypair, body, signed } = await makeSignedFixture();

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

  it("fails verification when method is altered", async () => {
    const { keypair, body, signed } = await makeSignedFixture();

    await expect(
      verifyHttpRequest({
        method: "PATCH",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
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
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_BODY_HASH_MISMATCH",
    });
  });

  it("fails verification when timestamp header is altered", async () => {
    const { keypair, body, signed } = await makeSignedFixture();
    const tamperedHeaders = {
      ...signed.headers,
      "X-Claw-Timestamp": "1739364999",
    };

    await expect(
      verifyHttpRequest({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: tamperedHeaders,
        body,
        publicKey: keypair.publicKey,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_INVALID_PROOF",
    });
  });
});
