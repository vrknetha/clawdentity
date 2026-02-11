import { describe, expect, it } from "vitest";
import { decodeBase64url, encodeBase64url } from "./base64url.js";
import { ProtocolParseError } from "./errors.js";

describe("base64url helpers", () => {
  it("roundtrips byte arrays", () => {
    const samples = [
      new Uint8Array(),
      Uint8Array.from([0]),
      Uint8Array.from([0, 1]),
      Uint8Array.from([0, 1, 2]),
      Uint8Array.from([255, 254, 253, 252, 251]),
      Uint8Array.from(Array.from({ length: 256 }, (_, index) => index)),
    ];

    for (const sample of samples) {
      const encoded = encodeBase64url(sample);
      const decoded = decodeBase64url(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(sample));
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
    }
  });

  it("decodes valid unpadded input", () => {
    expect(Array.from(decodeBase64url("Zm8"))).toEqual([102, 111]);
  });

  it("throws typed errors on invalid characters", () => {
    try {
      decodeBase64url("abc+");
      throw new Error("expected decodeBase64url to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_BASE64URL");
    }
  });

  it("throws typed errors on malformed length", () => {
    try {
      decodeBase64url("a");
      throw new Error("expected decodeBase64url to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolParseError);
      expect((error as ProtocolParseError).code).toBe("INVALID_BASE64URL");
    }
  });
});
