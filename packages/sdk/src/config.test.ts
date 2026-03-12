import { describe, expect, it } from "vitest";
import { parseRegistryConfig } from "./config.js";
import { AppError } from "./exceptions.js";

const bootstrapInternalServiceConfig = {
  BOOTSTRAP_INTERNAL_SERVICE_ID: "01HF7YAT00W6W7CM7N3W5FDXT4",
  BOOTSTRAP_INTERNAL_SERVICE_SECRET: "clw_srv_bootstrapsecret",
} as const;

describe("config helpers", () => {
  it("parses a valid registry config", () => {
    expect(
      parseRegistryConfig({
        ENVIRONMENT: "development",
        ...bootstrapInternalServiceConfig,
      }),
    ).toEqual({
      ENVIRONMENT: "development",
      ...bootstrapInternalServiceConfig,
    });
  });

  it("parses EVENT_BUS_BACKEND when provided", () => {
    expect(
      parseRegistryConfig({
        ENVIRONMENT: "development",
        EVENT_BUS_BACKEND: "queue",
        ...bootstrapInternalServiceConfig,
      }),
    ).toEqual({
      ENVIRONMENT: "development",
      EVENT_BUS_BACKEND: "queue",
      ...bootstrapInternalServiceConfig,
    });
  });

  it("parses REGISTRY_SIGNING_KEYS into validated key entries", () => {
    const config = parseRegistryConfig({
      ENVIRONMENT: "development",
      ...bootstrapInternalServiceConfig,
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

  it("parses APP_VERSION when provided", () => {
    expect(
      parseRegistryConfig({
        ENVIRONMENT: "development",
        APP_VERSION: "sha-abcdef123456",
        ...bootstrapInternalServiceConfig,
      }),
    ).toEqual({
      ENVIRONMENT: "development",
      APP_VERSION: "sha-abcdef123456",
      ...bootstrapInternalServiceConfig,
    });
  });

  it("parses PROXY_URL when provided", () => {
    expect(
      parseRegistryConfig({
        ENVIRONMENT: "development",
        PROXY_URL: "https://dev.proxy.clawdentity.com",
        ...bootstrapInternalServiceConfig,
      }),
    ).toEqual({
      ENVIRONMENT: "development",
      PROXY_URL: "https://dev.proxy.clawdentity.com",
      ...bootstrapInternalServiceConfig,
    });
  });

  it("parses REGISTRY_ISSUER_URL when provided", () => {
    expect(
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_ISSUER_URL: "http://host.docker.internal:8788",
        ...bootstrapInternalServiceConfig,
      }),
    ).toEqual({
      ENVIRONMENT: "development",
      REGISTRY_ISSUER_URL: "http://host.docker.internal:8788",
      ...bootstrapInternalServiceConfig,
    });
  });

  it("throws AppError when APP_VERSION is empty", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        APP_VERSION: "",
      });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
  });

  it("throws AppError when REGISTRY_ISSUER_URL is invalid", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_ISSUER_URL: "not-a-url",
      });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
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

  it("throws AppError on invalid EVENT_BUS_BACKEND", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        EVENT_BUS_BACKEND: "invalid",
      });
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

  it("throws AppError when REGISTRY_SIGNING_KEYS contains duplicate kids", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            status: "active",
          },
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICE",
            status: "revoked",
          },
        ]),
      });
      throw new Error("expected parseRegistryConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIG_VALIDATION_FAILED");
    }
  });

  it("throws AppError when REGISTRY_SIGNING_KEYS has malformed x", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "not+base64url",
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

  it("throws AppError when REGISTRY_SIGNING_KEYS x length is not Ed25519", () => {
    try {
      parseRegistryConfig({
        ENVIRONMENT: "development",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AQIDBA",
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

  it("fails when requireRuntimeKeys is enabled and required runtime keys are missing", () => {
    expect(() =>
      parseRegistryConfig(
        {
          ENVIRONMENT: "development",
        },
        { requireRuntimeKeys: true },
      ),
    ).toThrow(AppError);
  });

  it("passes requireRuntimeKeys validation when all required runtime keys are provided", () => {
    const config = parseRegistryConfig(
      {
        ENVIRONMENT: "development",
        PROXY_URL: "https://dev.proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://dev.registry.clawdentity.com",
        EVENT_BUS_BACKEND: "memory",
        BOOTSTRAP_SECRET: "bootstrap-secret",
        ...bootstrapInternalServiceConfig,
        REGISTRY_SIGNING_KEY:
          "VGVzdFNpZ25pbmdLZXlGb3JEZXZlbG9wbWVudF9PcGVyYXRpb25zMTIz",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            status: "active",
          },
        ]),
      },
      { requireRuntimeKeys: true },
    );

    expect(config.ENVIRONMENT).toBe("development");
    expect(config.PROXY_URL).toBe("https://dev.proxy.clawdentity.com");
  });

  it("skips non-bootstrap runtime key validation in local environment", () => {
    const config = parseRegistryConfig(
      {
        ENVIRONMENT: "local",
        ...bootstrapInternalServiceConfig,
      },
      { requireRuntimeKeys: true },
    );

    expect(config.ENVIRONMENT).toBe("local");
  });

  it("throws when only one bootstrap internal service key is provided", () => {
    expect(() =>
      parseRegistryConfig({
        ENVIRONMENT: "development",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "01HF7YAT00W6W7CM7N3W5FDXT4",
      }),
    ).toThrow(AppError);

    expect(() =>
      parseRegistryConfig({
        ENVIRONMENT: "development",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "clw_srv_bootstrapsecret",
      }),
    ).toThrow(AppError);
  });
});
