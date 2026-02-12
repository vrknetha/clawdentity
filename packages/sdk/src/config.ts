import { z } from "zod";
import { AppError } from "./exceptions.js";

const environmentSchema = z.enum(["development", "production", "test"]);

export const registryConfigSchema = z.object({
  ENVIRONMENT: environmentSchema,
  BOOTSTRAP_SECRET: z.string().min(1).optional(),
  REGISTRY_SIGNING_KEY: z.string().min(1).optional(),
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
