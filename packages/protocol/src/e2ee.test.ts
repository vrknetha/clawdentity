import { describe, expect, it } from "vitest";
import { encodeBase64url } from "./base64url.js";
import { parseEncryptedRelayPayloadV1 } from "./e2ee.js";
import { ProtocolParseError } from "./errors.js";

function makeFixedBytes(length: number, offset = 1): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (index + offset) % 256);
}

function makeValidPayload() {
  return {
    kind: "claw_e2ee_v1" as const,
    alg: "X25519_XCHACHA20POLY1305_HKDF_SHA256" as const,
    sessionId: "sess_01JABCDE1234567890",
    epoch: 1,
    counter: 0,
    nonce: encodeBase64url(makeFixedBytes(24)),
    ciphertext: encodeBase64url(makeFixedBytes(48, 3)),
    senderE2eePub: encodeBase64url(makeFixedBytes(32, 9)),
    rekeyPublicKey: undefined as string | undefined,
    sentAt: "2026-02-20T01:00:00.000Z",
  };
}

describe("E2EE relay payload schema", () => {
  it("accepts valid encrypted relay payloads", () => {
    const parsed = parseEncryptedRelayPayloadV1(makeValidPayload());
    expect(parsed.kind).toBe("claw_e2ee_v1");
    expect(parsed.alg).toBe("X25519_XCHACHA20POLY1305_HKDF_SHA256");
  });

  it("rejects invalid nonce lengths", () => {
    const payload = makeValidPayload();
    payload.nonce = encodeBase64url(makeFixedBytes(12));

    expect(() => parseEncryptedRelayPayloadV1(payload)).toThrow(
      ProtocolParseError,
    );
  });

  it("rejects invalid sender key lengths", () => {
    const payload = makeValidPayload();
    payload.senderE2eePub = encodeBase64url(makeFixedBytes(31));

    expect(() => parseEncryptedRelayPayloadV1(payload)).toThrow(
      ProtocolParseError,
    );
  });

  it("rejects invalid rekey key lengths", () => {
    const payload = makeValidPayload();
    payload.rekeyPublicKey = encodeBase64url(makeFixedBytes(31));

    expect(() => parseEncryptedRelayPayloadV1(payload)).toThrow(
      ProtocolParseError,
    );
  });

  it("rejects invalid sentAt timestamps", () => {
    const payload = makeValidPayload();
    payload.sentAt = "not-an-iso-time";

    expect(() => parseEncryptedRelayPayloadV1(payload)).toThrow(
      ProtocolParseError,
    );
  });

  it("rejects unknown fields", () => {
    const payload = {
      ...makeValidPayload(),
      unexpected: true,
    };

    expect(() => parseEncryptedRelayPayloadV1(payload)).toThrow(
      ProtocolParseError,
    );
  });
});
