import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "./index.js";

describe("cli", () => {
  it("exports CLI_VERSION", () => {
    expect(CLI_VERSION).toBe("0.0.0");
  });
});
