import { describe, expect, it } from "vitest";
import { makeAgentDid, makeHumanDid, parseDid } from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { generateUlid } from "./ulid.js";

describe("did helpers", () => {
  it("builds and parses human DIDs", () => {
    const ulid = generateUlid(1700000000000);
    const did = makeHumanDid(ulid);
    expect(did).toBe(`did:claw:human:${ulid}`);
    expect(parseDid(did)).toEqual({
      kind: "human",
      ulid,
    });
  });

  it("builds and parses agent DIDs", () => {
    const ulid = generateUlid(1700000000000);
    const did = makeAgentDid(ulid);
    expect(did).toBe(`did:claw:agent:${ulid}`);
    expect(parseDid(did)).toEqual({
      kind: "agent",
      ulid,
    });
  });

  it("rejects malformed DIDs", () => {
    const samples = [
      "did:claw:bot:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:other:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:claw:human",
      "did:claw:human:invalid-ulid",
    ];

    for (const sample of samples) {
      try {
        parseDid(sample);
        throw new Error("expected parseDid to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolParseError);
        expect((error as ProtocolParseError).code).toBe("INVALID_DID");
      }
    }
  });

  it("rejects invalid ULID input in make helpers", () => {
    try {
      makeHumanDid("invalid-ulid");
      throw new Error("expected makeHumanDid to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_DID");
    }
  });
});
