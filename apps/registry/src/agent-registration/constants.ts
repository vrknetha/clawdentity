import type { RegistryConfig } from "@clawdentity/sdk";

export const DEFAULT_AGENT_FRAMEWORK = "openclaw";
export const DEFAULT_AGENT_TTL_DAYS = 30;
export const MAX_FRAMEWORK_LENGTH = 32;
export const MIN_AGENT_TTL_DAYS = 1;
export const MAX_AGENT_TTL_DAYS = 90;
export const DAY_IN_SECONDS = 24 * 60 * 60;
export const ED25519_PUBLIC_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;
export const AGENT_REGISTRATION_CHALLENGE_TTL_SECONDS = 5 * 60;
export const AGENT_REGISTRATION_CHALLENGE_NONCE_LENGTH = 24;

const REGISTRY_ISSUER_BY_ENVIRONMENT: Record<
  RegistryConfig["ENVIRONMENT"],
  string
> = {
  local: "https://dev.registry.clawdentity.com",
  development: "https://dev.registry.clawdentity.com",
  production: "https://registry.clawdentity.com",
};

export function resolveRegistryIssuer(
  config: Pick<RegistryConfig, "ENVIRONMENT" | "REGISTRY_ISSUER_URL">,
): string {
  const explicitIssuer = config.REGISTRY_ISSUER_URL?.trim();
  if (explicitIssuer && explicitIssuer.length > 0) {
    return explicitIssuer;
  }

  return REGISTRY_ISSUER_BY_ENVIRONMENT[config.ENVIRONMENT];
}

export function resolveDidAuthorityFromIssuer(issuer: string): string {
  let parsedIssuer: URL;
  try {
    parsedIssuer = new URL(issuer);
  } catch {
    throw new Error("Registry issuer URL is invalid");
  }

  const authority = parsedIssuer.hostname.trim().toLowerCase();
  if (authority.length === 0) {
    throw new Error("Registry issuer URL must include a hostname");
  }

  return authority;
}
