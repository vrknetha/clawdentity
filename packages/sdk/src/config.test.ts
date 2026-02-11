import { describe, expect, it } from "vitest";
import { parseRegistryConfig } from "./config.js";
import { AppError } from "./exceptions.js";

describe("config helpers", () => {
  it("parses a valid registry config", () => {
    expect(parseRegistryConfig({ ENVIRONMENT: "development" })).toEqual({
      ENVIRONMENT: "development",
    });
  });

  it("throws AppError on invalid registry config", () => {
    try {
      parseRegistryConfig({ ENVIRONMENT: "local" });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
  });
});
