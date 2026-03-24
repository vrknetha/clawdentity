import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { AppError } from "@clawdentity/sdk";
import {
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
} from "../pairing-constants.js";

const FORWARDED_HOST_HEADER = "x-forwarded-host";
const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
const HOST_HEADER = "host";

function firstHeaderValue(value: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

function resolveRequestOrigin(request: Request): string | undefined {
  let fallbackUrl: URL | undefined;
  try {
    fallbackUrl = new URL(request.url);
  } catch {
    fallbackUrl = undefined;
  }

  const host =
    firstHeaderValue(request.headers.get(FORWARDED_HOST_HEADER)) ??
    firstHeaderValue(request.headers.get(HOST_HEADER));
  if (!host) {
    return fallbackUrl?.origin;
  }

  const proto =
    firstHeaderValue(request.headers.get(FORWARDED_PROTO_HEADER)) ??
    fallbackUrl?.protocol.replace(/:$/, "") ??
    "https";

  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return fallbackUrl?.origin;
  }
}

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

export function isLoopbackRegistryUrl(registryUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(registryUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveExpectedIssuer(
  registryUrl: string,
  request?: Request,
): string | undefined {
  try {
    const parsedRegistryUrl = new URL(registryUrl);
    if (!request || !isLoopbackHostname(parsedRegistryUrl.hostname)) {
      return parsedRegistryUrl.origin;
    }

    const requestOrigin = resolveRequestOrigin(request);
    if (!requestOrigin) {
      return parsedRegistryUrl.origin;
    }

    const requestUrl = new URL(requestOrigin);
    if (isLoopbackHostname(requestUrl.hostname)) {
      return parsedRegistryUrl.origin;
    }

    parsedRegistryUrl.protocol = requestUrl.protocol;
    parsedRegistryUrl.hostname = requestUrl.hostname;
    if (requestUrl.port.length === 0) {
      parsedRegistryUrl.port = "";
    }
    return parsedRegistryUrl.origin;
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
