import { describe, expect, it } from "vitest";
import {
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
});
