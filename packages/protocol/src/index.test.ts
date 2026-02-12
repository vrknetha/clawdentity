import { describe, expect, it } from "vitest";
import {
  CLAW_PROOF_CANONICAL_VERSION,
  canonicalizeRequest,
  decodeBase64url,
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
  PROTOCOL_VERSION,
  ProtocolParseError,
  parseDid,
  parseUlid,
} from "./index.js";

describe("protocol", () => {
  it("exports PROTOCOL_VERSION", () => {
    expect(PROTOCOL_VERSION).toBe("0.0.0");
  });

  it("exports helpers from package root", () => {
    const ulid = generateUlid(1700000000000);
    const humanDid = makeHumanDid(ulid);
    const agentDid = makeAgentDid(ulid);
    const encoded = encodeBase64url(Uint8Array.from([1, 2, 3]));

    expect(encoded).toBe("AQID");
    expect(Array.from(decodeBase64url(encoded))).toEqual([1, 2, 3]);
    expect(parseUlid(ulid).value).toBe(ulid);
    expect(parseDid(humanDid)).toEqual({ kind: "human", ulid });
    expect(parseDid(agentDid)).toEqual({ kind: "agent", ulid });
    expect(ProtocolParseError).toBeTypeOf("function");
  });

  it("exports http signing canonicalization helpers", () => {
    const canonical = canonicalizeRequest({
      method: "post",
      pathWithQuery: "/v1/messages?b=2&a=1",
      timestamp: "1739364000",
      nonce: "nonce_abc123",
      bodyHash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    });

    expect(CLAW_PROOF_CANONICAL_VERSION).toBe("CLAW-PROOF-V1");
    expect(canonical).toBe(
      [
        "CLAW-PROOF-V1",
        "POST",
        "/v1/messages?b=2&a=1",
        "1739364000",
        "nonce_abc123",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
      ].join("\n"),
    );
  });
});
