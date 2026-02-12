import { canonicalizeRequest } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  decodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  verifyEd25519,
} from "../crypto/ed25519.js";
import { signHttpRequest } from "./sign.js";

const textEncoder = new TextEncoder();

describe("signHttpRequest", () => {
  it("hashes body and returns proof-bound signature headers", async () => {
    const keypair = await generateEd25519Keypair();
    const body = textEncoder.encode('{"ok":true}');

    const signed = await signHttpRequest({
      method: "post",
      pathWithQuery: "/v1/messages?b=2&a=1",
      timestamp: "1739364000",
      nonce: "nonce_abc123",
      body,
      secretKey: keypair.secretKey,
    });

    expect(signed.headers["X-Claw-Timestamp"]).toBe("1739364000");
    expect(signed.headers["X-Claw-Nonce"]).toBe("nonce_abc123");
    expect(signed.headers["X-Claw-Body-SHA256"]).toBeTruthy();
    expect(signed.headers["X-Claw-Proof"]).toBeTruthy();

    expect(signed.canonicalRequest).toBe(
      canonicalizeRequest({
        method: "post",
        pathWithQuery: "/v1/messages?b=2&a=1",
        timestamp: "1739364000",
        nonce: "nonce_abc123",
        bodyHash: signed.headers["X-Claw-Body-SHA256"],
      }),
    );

    const signature = decodeEd25519SignatureBase64url(signed.proof);
    const verified = await verifyEd25519(
      signature,
      textEncoder.encode(signed.canonicalRequest),
      keypair.publicKey,
    );
    expect(verified).toBe(true);
  });

  it("uses SHA-256 base64url hash for empty body by default", async () => {
    const keypair = await generateEd25519Keypair();

    const signed = await signHttpRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      timestamp: "1739364500",
      nonce: "nonce_empty_body",
      secretKey: keypair.secretKey,
    });

    expect(signed.headers["X-Claw-Body-SHA256"]).toBe(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
  });
});
