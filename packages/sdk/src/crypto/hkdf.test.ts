import { describe, expect, it } from "vitest";
import { hkdfSha256, sha256, zeroBytes } from "./hkdf.js";

function bytes(length: number, start = 1): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (index + start) % 256);
}

describe("hkdf helpers", () => {
  it("derives deterministic output for the same input", async () => {
    const ikm = bytes(32, 7);
    const salt = bytes(32, 19);
    const info = new TextEncoder().encode("claw/e2ee/test");
    const a = await hkdfSha256({ ikm, salt, info, length: 32 });
    const b = await hkdfSha256({ ikm, salt, info, length: 32 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a).toHaveLength(32);
  });

  it("produces different outputs with different info", async () => {
    const ikm = bytes(32, 7);
    const salt = bytes(32, 19);
    const a = await hkdfSha256({
      ikm,
      salt,
      info: new TextEncoder().encode("info-a"),
      length: 32,
    });
    const b = await hkdfSha256({
      ikm,
      salt,
      info: new TextEncoder().encode("info-b"),
      length: 32,
    });
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("computes sha256 digests", async () => {
    const input = new TextEncoder().encode("clawdentity");
    const digest = await sha256(input);
    expect(digest).toHaveLength(32);
  });

  it("creates zero-filled byte arrays", () => {
    expect(Array.from(zeroBytes(4))).toEqual([0, 0, 0, 0]);
  });
});
