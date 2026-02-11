import { describe, expect, it } from "vitest";
import { REGISTRY_VERSION } from "./index.js";

describe("registry", () => {
  it("exports REGISTRY_VERSION", () => {
    expect(REGISTRY_VERSION).toBe("0.0.0");
  });
});
