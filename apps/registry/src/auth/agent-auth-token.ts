import { encodeBase64url } from "@clawdentity/protocol";
import { AppError } from "@clawdentity/sdk";

export const AGENT_ACCESS_TOKEN_MARKER = "clw_agt_";
export const AGENT_REFRESH_TOKEN_MARKER = "clw_rft_";
const AGENT_TOKEN_LOOKUP_ENTROPY_LENGTH = 8;
const AGENT_TOKEN_RANDOM_BYTES_LENGTH = 32;

function parseAgentToken(options: {
  token: string | undefined;
  marker: string;
  field: "accessToken" | "refreshToken";
}): string {
  const trimmedToken = options.token?.trim();

  if (!trimmedToken) {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_INVALID",
      message: "Refresh payload is invalid",
      status: 400,
      expose: true,
      details: {
        fieldErrors: {
          [options.field]: [`${options.field} is required`],
        },
        formErrors: [],
      },
    });
  }

  if (
    !trimmedToken.startsWith(options.marker) ||
    trimmedToken.length <= options.marker.length
  ) {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_INVALID",
      message: "Refresh payload is invalid",
      status: 400,
      expose: true,
      details: {
        fieldErrors: {
          [options.field]: [`${options.field} format is invalid`],
        },
        formErrors: [],
      },
    });
  }

  return trimmedToken;
}

export function parseAccessToken(token: string | undefined): string {
  return parseAgentToken({
    token,
    marker: AGENT_ACCESS_TOKEN_MARKER,
    field: "accessToken",
  });
}

export function parseRefreshToken(token: string | undefined): string {
  return parseAgentToken({
    token,
    marker: AGENT_REFRESH_TOKEN_MARKER,
    field: "refreshToken",
  });
}

function deriveTokenLookupPrefix(token: string, marker: string): string {
  const entropyPrefix = token.slice(
    marker.length,
    marker.length + AGENT_TOKEN_LOOKUP_ENTROPY_LENGTH,
  );

  return `${marker}${entropyPrefix}`;
}

export function deriveAccessTokenLookupPrefix(token: string): string {
  return deriveTokenLookupPrefix(token, AGENT_ACCESS_TOKEN_MARKER);
}

export function deriveRefreshTokenLookupPrefix(token: string): string {
  return deriveTokenLookupPrefix(token, AGENT_REFRESH_TOKEN_MARKER);
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(marker: string): string {
  const randomBytes = crypto.getRandomValues(
    new Uint8Array(AGENT_TOKEN_RANDOM_BYTES_LENGTH),
  );

  return `${marker}${encodeBase64url(randomBytes)}`;
}

export function generateAccessToken(): string {
  return generateToken(AGENT_ACCESS_TOKEN_MARKER);
}

export function generateRefreshToken(): string {
  return generateToken(AGENT_REFRESH_TOKEN_MARKER);
}
