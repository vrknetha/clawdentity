import { unauthorizedError } from "./errors.js";

export function parseClawAuthorizationHeader(authorization?: string): string {
  if (typeof authorization !== "string" || authorization.trim().length === 0) {
    throw unauthorizedError({
      code: "PROXY_AUTH_MISSING_TOKEN",
      message: "Authorization header is required",
    });
  }

  const parsed = authorization.trim().match(/^Claw\s+(\S+)$/);
  if (!parsed || parsed[1].trim().length === 0) {
    throw unauthorizedError({
      code: "PROXY_AUTH_INVALID_SCHEME",
      message: "Authorization must be in the format 'Claw <ait>'",
    });
  }

  return parsed[1].trim();
}

export function parseAgentAccessHeader(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unauthorizedError({
      code: "PROXY_AGENT_ACCESS_REQUIRED",
      message: "X-Claw-Agent-Access header is required",
    });
  }

  return value.trim();
}
