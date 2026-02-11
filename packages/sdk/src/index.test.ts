import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./index.js";

describe("sdk", () => {
  it("exports SDK_VERSION", () => {
    expect(SDK_VERSION).toBe("0.0.0");
  });
});
