import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./index.js";

describe("protocol", () => {
  it("exports PROTOCOL_VERSION", () => {
    expect(PROTOCOL_VERSION).toBe("0.0.0");
  });
});
