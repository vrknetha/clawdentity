import { sanitizeErrorReason as sanitizeReason } from "@clawdentity/common";
import { AppError } from "@clawdentity/sdk";

export class LocalOpenclawDeliveryError extends Error {
  readonly code?: "HOOK_AUTH_REJECTED" | "RUNTIME_STOPPING";
  readonly retryable: boolean;

  constructor(input: {
    code?: "HOOK_AUTH_REJECTED" | "RUNTIME_STOPPING";
    message: string;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "LocalOpenclawDeliveryError";
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export function sanitizeErrorReason(error: unknown): string {
  return sanitizeReason(error, {
    fallback: "Unknown error",
    maxLength: 240,
  });
}

export function isRetryableRelayAuthError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "OPENCLAW_RELAY_AGENT_AUTH_REJECTED" &&
    error.status === 401
  );
}
