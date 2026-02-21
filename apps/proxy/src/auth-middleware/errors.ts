import { AppError } from "@clawdentity/sdk";

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export function unauthorizedError(options: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): AppError {
  return new AppError({
    code: options.code,
    message: options.message,
    status: 401,
    details: options.details,
    expose: true,
  });
}

export function dependencyUnavailableError(options: {
  message: string;
  details?: Record<string, unknown>;
}): AppError {
  return new AppError({
    code: "PROXY_AUTH_DEPENDENCY_UNAVAILABLE",
    message: options.message,
    status: 503,
    details: options.details,
    expose: true,
  });
}
