import { decodeBase64url } from "@clawdentity/protocol";
import { z } from "zod";
import { AppError } from "./exceptions.js";
import { runtimeEnvironmentValues } from "./runtime-environment.js";

const environmentSchema = z.enum(runtimeEnvironmentValues);
const registrySigningKeyStatusSchema = z.enum(["active", "revoked"]);
const registryEventBusBackendSchema = z.enum(["memory", "queue"]);
const ED25519_PUBLIC_KEY_LENGTH = 32;

const registrySigningPublicKeySchema = z
  .object({
    kid: z.string().min(1),
    alg: z.literal("EdDSA"),
    crv: z.literal("Ed25519"),
    x: z.string().min(1),
    status: registrySigningKeyStatusSchema,
  })
  .superRefine((value, ctx) => {
    let decodedPublicKey: Uint8Array;

    try {
      decodedPublicKey = decodeBase64url(value.x);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["x"],
        message: "x must be valid base64url",
      });
      return;
    }

    if (decodedPublicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["x"],
        message: "x must decode to 32-byte Ed25519 public key",
      });
    }
  });

const registrySigningKeysSchema = z
  .array(registrySigningPublicKeySchema)
  .superRefine((keys, ctx) => {
    const seenKids = new Set<string>();
    for (const [index, key] of keys.entries()) {
      if (seenKids.has(key.kid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "kid"],
          message: `Duplicate kid "${key.kid}" is not allowed`,
        });
      } else {
        seenKids.add(key.kid);
      }
    }
  });

const registrySigningKeysEnvSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "REGISTRY_SIGNING_KEYS must be valid JSON",
      });
      return z.NEVER;
    }

    const keys = registrySigningKeysSchema.safeParse(parsed);
    if (!keys.success) {
      for (const issue of keys.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
      return z.NEVER;
    }

    return keys.data;
  });

export const registryConfigSchema = z.object({
  ENVIRONMENT: environmentSchema,
  APP_VERSION: z.string().min(1).optional(),
  PROXY_URL: z.string().url().optional(),
  REGISTRY_ISSUER_URL: z.string().url().optional(),
  EVENT_BUS_BACKEND: registryEventBusBackendSchema.optional(),
  BOOTSTRAP_SECRET: z.string().min(1).optional(),
  BOOTSTRAP_INTERNAL_SERVICE_ID: z.string().min(1),
  BOOTSTRAP_INTERNAL_SERVICE_SECRET: z.string().min(1),
  REGISTRY_SIGNING_KEY: z.string().min(1).optional(),
  REGISTRY_SIGNING_KEYS: registrySigningKeysEnvSchema.optional(),
});

export type RegistryConfig = z.infer<typeof registryConfigSchema>;

type ParseRegistryConfigOptions = {
  requireRuntimeKeys?: boolean;
};

const REQUIRED_REGISTRY_RUNTIME_KEYS = [
  "PROXY_URL",
  "REGISTRY_ISSUER_URL",
  "EVENT_BUS_BACKEND",
  "BOOTSTRAP_SECRET",
  "BOOTSTRAP_INTERNAL_SERVICE_ID",
  "BOOTSTRAP_INTERNAL_SERVICE_SECRET",
  "REGISTRY_SIGNING_KEY",
  "REGISTRY_SIGNING_KEYS",
] as const;

function throwRegistryConfigValidationError(details: {
  fieldErrors: Record<string, string[]>;
  formErrors: string[];
}): never {
  throw new AppError({
    code: "CONFIG_VALIDATION_FAILED",
    message: "Registry configuration is invalid",
    status: 500,
    expose: true,
    details,
  });
}

function assertRequiredRegistryRuntimeKeys(input: RegistryConfig): void {
  if (input.ENVIRONMENT === "local") {
    return;
  }

  const fieldErrors: Record<string, string[]> = {};
  for (const key of REQUIRED_REGISTRY_RUNTIME_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      continue;
    }

    if (
      value !== undefined &&
      value !== null &&
      !(typeof value === "string" && value.trim().length === 0)
    ) {
      continue;
    }

    fieldErrors[key] = [`${key} is required`];
  }

  if (Object.keys(fieldErrors).length > 0) {
    throwRegistryConfigValidationError({
      fieldErrors,
      formErrors: [],
    });
  }
}

function assertBootstrapInternalServicePair(input: RegistryConfig): void {
  const hasServiceId =
    typeof input.BOOTSTRAP_INTERNAL_SERVICE_ID === "string" &&
    input.BOOTSTRAP_INTERNAL_SERVICE_ID.trim().length > 0;
  const hasServiceSecret =
    typeof input.BOOTSTRAP_INTERNAL_SERVICE_SECRET === "string" &&
    input.BOOTSTRAP_INTERNAL_SERVICE_SECRET.trim().length > 0;
  if (hasServiceId === hasServiceSecret) {
    return;
  }

  throwRegistryConfigValidationError({
    fieldErrors: {
      BOOTSTRAP_INTERNAL_SERVICE_ID: [
        "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
      ],
      BOOTSTRAP_INTERNAL_SERVICE_SECRET: [
        "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
      ],
    },
    formErrors: [],
  });
}

export function parseRegistryConfig(
  env: unknown,
  options: ParseRegistryConfigOptions = {},
): RegistryConfig {
  const parsed = registryConfigSchema.safeParse(env);
  if (parsed.success) {
    assertBootstrapInternalServicePair(parsed.data);
    if (options.requireRuntimeKeys === true) {
      assertRequiredRegistryRuntimeKeys(parsed.data);
    }
    return parsed.data;
  }

  throwRegistryConfigValidationError({
    fieldErrors: parsed.error.flatten().fieldErrors,
    formErrors: parsed.error.flatten().formErrors,
  });
}
