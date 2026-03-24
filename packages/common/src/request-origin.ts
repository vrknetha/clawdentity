const FORWARDED_HOST_HEADER = "x-forwarded-host";
const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
const HOST_HEADER = "host";

export function firstHeaderValue(value: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
}

export function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

export function resolveRequestOrigin(request: Request): string | undefined {
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
