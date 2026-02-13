import { describe, expect, it } from "vitest";
import { parseRegistryConfig } from "./config.js";
import { AppError } from "./exceptions.js";

describe("config helpers", () => {
  it("parses a valid registry config", () => {
    expect(parseRegistryConfig({ ENVIRONMENT: "development" })).toEqual({
      ENVIRONMENT: "development",
    });
  });

  it("parses REGISTRY_SIGNING_KEYS into validated key entries", () => {
    const config = parseRegistryConfig({
      ENVIRONMENT: "development",
      REGISTRY_SIGNING_KEYS: JSON.stringify([
        {
          kid: "reg-key-1",
          alg: "EdDSA",
          crv: "Ed25519",
          x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          status: "active",
        },
      ]),
    });

    expect(config.REGISTRY_SIGNING_KEYS).toEqual([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        status: "active",
      },
    ]);
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

  it("throws AppError when REGISTRY_SIGNING_KEYS is invalid JSON", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_SIGNING_KEYS: "not-json",
      });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
  });

  it("throws AppError when REGISTRY_SIGNING_KEYS entries violate schema", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "",
            alg: "ES256",
            crv: "Ed25519",
            x: "",
            status: "active",
          },
        ]),
      });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
  });
});
