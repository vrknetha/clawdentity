import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  deriveEd25519PublicKey,
  type Ed25519KeypairBytes,
  type RegistryConfig,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";

const ED25519_SECRET_KEY_LENGTH = 32;

type RegistrySigningKey = NonNullable<
  RegistryConfig["REGISTRY_SIGNING_KEYS"]
>[number];

export type ResolvedRegistrySigner = {
  signerKid: string;
  signerKeypair: Ed25519KeypairBytes;
};

function invalidSigningConfig(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  field: "REGISTRY_SIGNING_KEY" | "REGISTRY_SIGNING_KEYS";
  message: string;
}): AppError {
  const exposeDetails = shouldExposeVerboseErrors(options.environment);
  return new AppError({
    code: "CONFIG_VALIDATION_FAILED",
    message: exposeDetails
      ? "Registry configuration is invalid"
      : "Request could not be processed",
    status: 500,
    expose: exposeDetails,
    details: exposeDetails
      ? {
          fieldErrors: {
            [options.field]: [options.message],
          },
          formErrors: [],
        }
      : undefined,
  });
}

function parseRegistrySecretKey(
  environment: RegistryConfig["ENVIRONMENT"],
  secretKeyBase64url: string | undefined,
): Uint8Array {
  if (!secretKeyBase64url) {
    throw invalidSigningConfig({
      environment,
      field: "REGISTRY_SIGNING_KEY",
      message: "REGISTRY_SIGNING_KEY is not configured",
    });
  }

  let decodedSecretKey: Uint8Array;
  try {
    decodedSecretKey = decodeBase64url(secretKeyBase64url);
  } catch {
    throw invalidSigningConfig({
      environment,
      field: "REGISTRY_SIGNING_KEY",
      message: "REGISTRY_SIGNING_KEY must be valid base64url",
    });
  }

  if (decodedSecretKey.length !== ED25519_SECRET_KEY_LENGTH) {
    throw invalidSigningConfig({
      environment,
      field: "REGISTRY_SIGNING_KEY",
      message: "REGISTRY_SIGNING_KEY must decode to 32 bytes",
    });
  }

  return decodedSecretKey;
}

function findMatchingActiveKey(options: {
  environment: RegistryConfig["ENVIRONMENT"];
  keys: RegistrySigningKey[];
  publicKeyBase64url: string;
}): RegistrySigningKey {
  const activeKeys = options.keys.filter((key) => key.status === "active");
  if (activeKeys.length === 0) {
    throw invalidSigningConfig({
      environment: options.environment,
      field: "REGISTRY_SIGNING_KEYS",
      message: "REGISTRY_SIGNING_KEYS must include an active key",
    });
  }

  const matchingKey = activeKeys.find(
    (key) => key.x === options.publicKeyBase64url,
  );

  if (!matchingKey) {
    throw invalidSigningConfig({
      environment: options.environment,
      field: "REGISTRY_SIGNING_KEYS",
      message:
        "REGISTRY_SIGNING_KEY does not match any active REGISTRY_SIGNING_KEYS entry",
    });
  }

  return matchingKey;
}

export async function resolveRegistrySigner(
  config: RegistryConfig,
): Promise<ResolvedRegistrySigner> {
  const publicKeys = config.REGISTRY_SIGNING_KEYS;
  if (!publicKeys || publicKeys.length === 0) {
    throw invalidSigningConfig({
      environment: config.ENVIRONMENT,
      field: "REGISTRY_SIGNING_KEYS",
      message: "REGISTRY_SIGNING_KEYS is not configured",
    });
  }

  const secretKey = parseRegistrySecretKey(
    config.ENVIRONMENT,
    config.REGISTRY_SIGNING_KEY,
  );
  const publicKey = await deriveEd25519PublicKey(secretKey);
  const publicKeyBase64url = encodeBase64url(publicKey);
  const signingKey = findMatchingActiveKey({
    environment: config.ENVIRONMENT,
    keys: publicKeys,
    publicKeyBase64url,
  });

  return {
    signerKid: signingKey.kid,
    signerKeypair: {
      publicKey,
      secretKey,
    },
  };
}
