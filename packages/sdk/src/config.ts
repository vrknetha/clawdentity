import { decodeBase64url } from "@clawdentity/protocol";
import { z } from "zod";
import { AppError } from "./exceptions.js";

const environmentSchema = z.enum(["development", "production", "test"]);
const registrySigningKeyStatusSchema = z.enum(["active", "revoked"]);
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
  BOOTSTRAP_SECRET: z.string().min(1).optional(),
  REGISTRY_SIGNING_KEY: z.string().min(1).optional(),
  REGISTRY_SIGNING_KEYS: registrySigningKeysEnvSchema.optional(),
});

export type RegistryConfig = z.infer<typeof registryConfigSchema>;

export function parseRegistryConfig(env: unknown): RegistryConfig {
  const parsed = registryConfigSchema.safeParse(env);
  if (parsed.success) {
    return parsed.data;
  }

  throw new AppError({
    code: "CONFIG_VALIDATION_FAILED",
    message: "Registry configuration is invalid",
    status: 500,
    expose: true,
    details: {
      fieldErrors: parsed.error.flatten().fieldErrors,
      formErrors: parsed.error.flatten().formErrors,
    },
  });
}
