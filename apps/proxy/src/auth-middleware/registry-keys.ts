import { parseRegistryConfig } from "@clawdentity/sdk";
import { dependencyUnavailableError, toErrorMessage } from "./errors.js";
import type { RegistrySigningKey, VerificationKey } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseRegistrySigningKeys(
  payload: unknown,
): RegistrySigningKey[] {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) {
    throw dependencyUnavailableError({
      message: "Registry signing keys payload is invalid",
    });
  }

  const parsed = (() => {
    try {
      return parseRegistryConfig({
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEYS: JSON.stringify(payload.keys),
      });
    } catch (error) {
      throw dependencyUnavailableError({
        message: "Registry signing keys are invalid",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }
  })();

  const keys = parsed.REGISTRY_SIGNING_KEYS ?? [];
  if (keys.length === 0) {
    throw dependencyUnavailableError({
      message: "Registry signing keys are unavailable",
    });
  }

  return keys;
}

export function toVerificationKeys(
  keys: RegistrySigningKey[],
): VerificationKey[] {
  return keys
    .filter((key) => key.status === "active")
    .map((key) => ({
      kid: key.kid,
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: key.x,
      },
    }));
}
