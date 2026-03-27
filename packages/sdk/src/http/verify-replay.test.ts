import { describe, expect, it } from "vitest";
import { generateEd25519Keypair } from "../crypto/ed25519.js";
import { signHttpRequest } from "./sign.js";
import { verifyHttpRequestWithReplayProtection } from "./verify.js";

const textEncoder = new TextEncoder();
const NOW_MS = 1_739_364_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

async function makeSignedFixture(input?: {
  timestamp?: string;
  nonce?: string;
  body?: Uint8Array;
}) {
  const keypair = await generateEd25519Keypair();
  const body = input?.body ?? textEncoder.encode('{"hello":"world"}');
  const timestamp = input?.timestamp ?? String(NOW_SECONDS);
  const nonce = input?.nonce ?? "nonce_replay_test";
  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: "/v1/messages?b=2&a=1",
    timestamp,
    nonce,
    body,
    secretKey: keypair.secretKey,
  });

  return { keypair, body, signed, nonce };
}

describe("verifyHttpRequestWithReplayProtection", () => {
  it("accepts first nonce and rejects replayed nonce", async () => {
    const { keypair, body, signed } = await makeSignedFixture();
    const seen = new Set<string>();
    const nonceChecker = {
      tryAcceptNonce(input: { agentDid: string; nonce: string }) {
        const key = `${input.agentDid}|${input.nonce}`;
        if (seen.has(key)) {
          return { accepted: false as const, reason: "replay" as const };
        }
        seen.add(key);
        return { accepted: true as const };
      },
    };

    await expect(
      verifyHttpRequestWithReplayProtection({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        nonceChecker,
        nowMs: NOW_MS,
      }),
    ).resolves.toMatchObject({
      proof: signed.proof,
    });

    await expect(
      verifyHttpRequestWithReplayProtection({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        nonceChecker,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_REPLAY_DETECTED",
    });
  });

  it("preserves signature/body verification failures", async () => {
    const { keypair, signed } = await makeSignedFixture();
    const nonceChecker = {
      tryAcceptNonce() {
        return { accepted: true as const };
      },
    };

    await expect(
      verifyHttpRequestWithReplayProtection({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body: textEncoder.encode('{"hello":"tampered"}'),
        publicKey: keypair.publicKey,
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        nonceChecker,
        nowMs: NOW_MS,
      }),
    ).rejects.toMatchObject({
      code: "HTTP_SIGNATURE_BODY_HASH_MISMATCH",
    });
  });

  it("supports async nonce checkers", async () => {
    const { keypair, body, signed } = await makeSignedFixture({
      nonce: "nonce_async",
    });
    const nonceChecker = {
      async tryAcceptNonce() {
        return { accepted: true as const, seenAt: NOW_MS, expiresAt: NOW_MS };
      },
    };

    await expect(
      verifyHttpRequestWithReplayProtection({
        method: "POST",
        pathWithQuery: "/v1/messages?b=2&a=1",
        headers: signed.headers,
        body,
        publicKey: keypair.publicKey,
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        nonceChecker,
        nowMs: NOW_MS,
      }),
    ).resolves.toMatchObject({
      proof: signed.proof,
    });
  });
});
