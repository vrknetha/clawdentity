import { describe, expect, it } from "vitest";
import { ProtocolParseError } from "./errors.js";
import { generateUlid, parseUlid } from "./ulid.js";

describe("ulid helpers", () => {
  it("generates a canonical ULID", () => {
    const value = generateUlid();
    expect(value).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("supports deterministic timestamp generation", () => {
    const now = 1700000000000;
    const value = generateUlid(now);
    const parsed = parseUlid(value);
    expect(parsed.timestampMs).toBe(now);
  });

  it("roundtrips generated ULIDs", () => {
    const value = generateUlid();
    expect(parseUlid(value)).toEqual({
      value,
      timestampMs: expect.any(Number),
    });
  });

  it("throws typed errors on invalid ULIDs", () => {
    try {
      parseUlid("invalid-ulid");
      throw new Error("expected parseUlid to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_ULID");
    }
  });

  it("rejects lowercase ULIDs", () => {
    const value = generateUlid().toLowerCase();
    try {
      parseUlid(value);
      throw new Error("expected parseUlid to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_ULID");
    }
  });
});
