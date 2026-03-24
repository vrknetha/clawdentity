import { type AitClaims, decodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  nowUtcMs,
  type RegistryAitVerificationKey,
  type RegistryConfig,
  verifyAIT,
  verifyHttpRequest,
} from "@clawdentity/sdk";
import { resolvePublicRegistryIssuer } from "../server/helpers/parsers.js";

const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;

function unauthorizedError(message: string): AppError {
  return new AppError({
    code: "AGENT_AUTH_REFRESH_UNAUTHORIZED",
    message,
    status: 401,
    expose: true,
  });
}

function parseClawAuthorizationHeader(authorization?: string): string {
  if (typeof authorization !== "string" || authorization.trim().length === 0) {
    throw unauthorizedError("Authorization header is required");
  }

  const parsed = authorization.trim().match(/^Claw\s+(\S+)$/);
  if (!parsed || parsed[1].trim().length === 0) {
    throw unauthorizedError("Authorization must be in the format 'Claw <ait>'");
  }

  return parsed[1].trim();
}

function parseUnixTimestamp(headerValue: string): number {
  if (!/^\d+$/.test(headerValue)) {
    throw unauthorizedError("X-Claw-Timestamp must be a unix seconds integer");
  }

  const timestamp = Number.parseInt(headerValue, 10);
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw unauthorizedError("X-Claw-Timestamp must be a unix seconds integer");
  }

  return timestamp;
}

function assertTimestampWithinSkew(options: {
  nowMs: number;
  maxSkewSeconds: number;
  timestampSeconds: number;
}): void {
  const nowSeconds = Math.floor(options.nowMs / 1000);
  const skew = Math.abs(nowSeconds - options.timestampSeconds);

  if (skew > options.maxSkewSeconds) {
    throw unauthorizedError(
      "X-Claw-Timestamp is outside the allowed skew window",
    );
  }
}

function toPathWithQuery(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return `${parsed.pathname}${parsed.search}`;
}

function buildRegistryVerificationKeys(
  keys: RegistryConfig["REGISTRY_SIGNING_KEYS"],
): RegistryAitVerificationKey[] {
  return (keys ?? [])
    .filter((key) => key.status === "active")
    .map((key) => ({
      kid: key.kid,
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: key.x,
      },
    }));
}

export async function verifyAgentClawRequest(input: {
  config: RegistryConfig;
  request: Request;
  bodyBytes: Uint8Array;
  nowMs?: number;
  maxTimestampSkewSeconds?: number;
}): Promise<AitClaims> {
  const nowMs = input.nowMs ?? nowUtcMs();
  const maxTimestampSkewSeconds =
    input.maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS;
  const token = parseClawAuthorizationHeader(
    input.request.headers.get("authorization") ?? undefined,
  );
  const expectedIssuer = resolvePublicRegistryIssuer({
    request: input.request,
    config: input.config,
  });
  const verificationKeys = buildRegistryVerificationKeys(
    input.config.REGISTRY_SIGNING_KEYS,
  );

  if (verificationKeys.length === 0) {
    throw unauthorizedError("Registry signing keys are unavailable");
  }

  let claims: AitClaims;
  try {
    claims = await verifyAIT({
      token,
      registryKeys: verificationKeys,
      expectedIssuer,
    });
  } catch {
    throw unauthorizedError("AIT verification failed");
  }

  const timestampHeader = input.request.headers.get("x-claw-timestamp");
  if (!timestampHeader) {
    throw unauthorizedError("X-Claw-Timestamp header is required");
  }

  assertTimestampWithinSkew({
    nowMs,
    maxSkewSeconds: maxTimestampSkewSeconds,
    timestampSeconds: parseUnixTimestamp(timestampHeader),
  });

  let cnfPublicKey: Uint8Array;
  try {
    cnfPublicKey = decodeBase64url(claims.cnf.jwk.x);
  } catch {
    throw unauthorizedError("AIT public key is invalid");
  }

  try {
    await verifyHttpRequest({
      method: input.request.method,
      pathWithQuery: toPathWithQuery(input.request.url),
      headers: Object.fromEntries(input.request.headers.entries()),
      body: input.bodyBytes,
      publicKey: cnfPublicKey,
    });
  } catch {
    throw unauthorizedError("PoP verification failed");
  }

  return claims;
}
