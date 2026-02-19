const CLAWDENTITY_ENV_OVERRIDE_KEYS = [
  "CLAWDENTITY_REGISTRY_URL",
  "CLAWDENTITY_REGISTRY",
  "CLAWDENTITY_PROXY_URL",
  "CLAWDENTITY_API_KEY",
] as const;

export function resetClawdentityEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  for (const key of CLAWDENTITY_ENV_OVERRIDE_KEYS) {
    delete sanitized[key];
  }

  return sanitized;
}
