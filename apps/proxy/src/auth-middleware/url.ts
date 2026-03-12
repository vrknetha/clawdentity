import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { AppError } from "@clawdentity/sdk";
import {
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
} from "../pairing-constants.js";

export function toPathWithQuery(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return `${parsed.pathname}${parsed.search}`;
}

export function normalizeRegistryUrl(registryUrl: string): string {
  try {
    return new URL(registryUrl).toString();
  } catch {
    throw new AppError({
      code: "PROXY_AUTH_INVALID_REGISTRY_URL",
      message: "Proxy registry URL is invalid",
      status: 500,
      expose: true,
    });
  }
}

export function toRegistryUrl(registryUrl: string, path: string): string {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
}

export function resolveExpectedIssuer(registryUrl: string): string | undefined {
  try {
    return new URL(registryUrl).origin;
  } catch {
    return undefined;
  }
}

export function shouldSkipKnownAgentCheck(path: string): boolean {
  return (
    path === PAIR_START_PATH ||
    path === PAIR_CONFIRM_PATH ||
    path === PAIR_STATUS_PATH ||
    path === RELAY_CONNECT_PATH
  );
}
