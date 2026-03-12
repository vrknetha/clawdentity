import { AppError } from "@clawdentity/sdk";

export function normalizeInternalServiceScopes(
  scopes: readonly string[],
): string[] {
  return [
    ...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope)),
  ];
}

export function parseInternalServiceScopesPayload(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID",
      message: "Internal service payload is invalid",
      status: 400,
      expose: true,
    });
  }

  const scopes = normalizeInternalServiceScopes(
    value.filter((scope): scope is string => typeof scope === "string"),
  );
  if (scopes.length === 0) {
    throw new AppError({
      code: "INTERNAL_SERVICE_INVALID",
      message: "Internal service payload is invalid",
      status: 400,
      expose: true,
    });
  }

  return scopes;
}

export function parseInternalServiceScopesJson(scopesJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopesJson);
  } catch {
    throw new AppError({
      code: "INTERNAL_SERVICE_CONFIG_INVALID",
      message: "Internal service scopes are invalid",
      status: 500,
      expose: true,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new AppError({
      code: "INTERNAL_SERVICE_CONFIG_INVALID",
      message: "Internal service scopes are invalid",
      status: 500,
      expose: true,
    });
  }

  return normalizeInternalServiceScopes(
    parsed.filter((scope): scope is string => typeof scope === "string"),
  );
}
