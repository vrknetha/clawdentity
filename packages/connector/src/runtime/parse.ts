import { isRecord as isObjectRecord } from "@clawdentity/common";
import type { AgentAuthBundle } from "@clawdentity/sdk";
import { ACCESS_TOKEN_REFRESH_SKEW_MS } from "./constants.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectRecord(value);
}

export function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field}`);
  }

  return value.trim();
}

export function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOptionalProxyOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    return new URL(value.trim()).origin;
  } catch {
    return undefined;
  }
}

export function parsePositiveIntEnv(
  key: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

export function parseRequestIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    ),
  );
}

export function parseIsoTimestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

export function shouldRefreshAccessToken(
  auth: AgentAuthBundle,
  nowMs: number,
): boolean {
  if (auth.accessToken.trim().length === 0) {
    return true;
  }

  const expiresAtMs = parseIsoTimestampMs(auth.accessExpiresAt);
  if (expiresAtMs === undefined) {
    return false;
  }

  return expiresAtMs <= nowMs + ACCESS_TOKEN_REFRESH_SKEW_MS;
}
