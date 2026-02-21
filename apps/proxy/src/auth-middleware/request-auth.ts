import type { VerifyHttpRequestInput } from "@clawdentity/sdk";
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

export function parseUnixTimestamp(headerValue: string): number {
  if (!/^\d+$/.test(headerValue)) {
    throw unauthorizedError({
      code: "PROXY_AUTH_INVALID_TIMESTAMP",
      message: "X-Claw-Timestamp must be a unix seconds integer",
    });
  }

  const timestamp = Number.parseInt(headerValue, 10);
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw unauthorizedError({
      code: "PROXY_AUTH_INVALID_TIMESTAMP",
      message: "X-Claw-Timestamp must be a unix seconds integer",
    });
  }

  return timestamp;
}

export function assertTimestampWithinSkew(options: {
  clock: () => number;
  maxSkewSeconds: number;
  timestampSeconds: number;
}): void {
  const nowSeconds = Math.floor(options.clock() / 1000);
  const skew = Math.abs(nowSeconds - options.timestampSeconds);
  if (skew > options.maxSkewSeconds) {
    throw unauthorizedError({
      code: "PROXY_AUTH_TIMESTAMP_SKEW",
      message: "X-Claw-Timestamp is outside the allowed skew window",
      details: {
        maxSkewSeconds: options.maxSkewSeconds,
      },
    });
  }
}

export function toProofVerificationInput(input: {
  method: string;
  pathWithQuery: string;
  headers: Headers;
  body: Uint8Array;
  publicKey: Uint8Array;
}): VerifyHttpRequestInput {
  const headers = Object.fromEntries(input.headers.entries());
  return {
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    headers,
    body: input.body,
    publicKey: input.publicKey,
  };
}
