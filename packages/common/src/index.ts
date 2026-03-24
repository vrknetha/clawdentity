export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sanitizeErrorReason(
  error: unknown,
  input?: {
    fallback?: string;
    maxLength?: number;
  },
): string {
  const fallback = input?.fallback ?? "Unknown error";
  const maxLength = Math.max(1, input?.maxLength ?? 240);

  if (!(error instanceof Error)) {
    return fallback;
  }

  const message = error.message.trim();
  return message.slice(0, maxLength) || fallback;
}

export function toOpenclawHookUrl(baseUrl: string, hookPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedHookPath = hookPath.startsWith("/")
    ? hookPath.slice(1)
    : hookPath;
  return new URL(normalizedHookPath, normalizedBase).toString();
}

export async function parseJsonResponseSafe(
  response: Response,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export {
  firstHeaderValue,
  isLoopbackHostname,
  normalizeHostname,
  resolveRequestOrigin,
} from "./request-origin.js";
