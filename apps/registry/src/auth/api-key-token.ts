import { encodeBase64url } from "@clawdentity/protocol";
import { AppError } from "@clawdentity/sdk";

export const PAT_TOKEN_MARKER = "clw_pat_";
const PAT_LOOKUP_ENTROPY_LENGTH = 8;
const PAT_RANDOM_BYTES_LENGTH = 32;

export function parseBearerPat(authorization?: string): string {
  if (!authorization) {
    throw new AppError({
      code: "API_KEY_MISSING",
      message: "Authorization header is required",
      status: 401,
      expose: true,
    });
  }

  const [scheme, token] = authorization.trim().split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must be in the format 'Bearer <pat>'",
      status: 401,
      expose: true,
    });
  }

  if (!token.startsWith(PAT_TOKEN_MARKER)) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must contain a PAT token",
      status: 401,
      expose: true,
    });
  }

  if (token.length <= PAT_TOKEN_MARKER.length) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must contain a PAT token",
      status: 401,
      expose: true,
    });
  }

  return token;
}

export function deriveApiKeyLookupPrefix(token: string): string {
  const entropyPrefix = token.slice(
    PAT_TOKEN_MARKER.length,
    PAT_TOKEN_MARKER.length + PAT_LOOKUP_ENTROPY_LENGTH,
  );

  return `${PAT_TOKEN_MARKER}${entropyPrefix}`;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

export async function hashApiKeyToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function generateApiKeyToken(): string {
  const randomBytes = crypto.getRandomValues(
    new Uint8Array(PAT_RANDOM_BYTES_LENGTH),
  );
  return `${PAT_TOKEN_MARKER}${encodeBase64url(randomBytes)}`;
}
