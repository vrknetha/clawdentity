import { describe, expect, it } from "vitest";
import { PROXY_VERSION } from "./index.js";

describe("proxy", () => {
  it("exports PROXY_VERSION", () => {
    expect(PROXY_VERSION).toBe("0.0.0");
  });
});
