import { decodeBase64url } from "@clawdentity/protocol";
import {
  AitJwtError,
  AppError,
  type CrlCache,
  CrlJwtError,
  createCrlCache,
  createNonceCache,
  type Logger,
  type NonceCache,
  parseRegistryConfig,
  type RequestContextVariables,
  type VerifyHttpRequestInput,
  verifyAIT,
  verifyCRL,
  verifyHttpRequest,
} from "@clawdentity/sdk";
import { createMiddleware } from "hono/factory";
import type { ProxyConfig } from "./config.js";

export const DEFAULT_REGISTRY_KEYS_CACHE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;

type RegistrySigningKey = NonNullable<
  ReturnType<typeof parseRegistryConfig>["REGISTRY_SIGNING_KEYS"]
>[number];

type VerificationKey = {
  kid: string;
  jwk: {
    kty: "OKP";
    crv: "Ed25519";
    x: string;
  };
};

export type ProxyAuthContext = {
  agentDid: string;
  ownerDid: string;
  aitJti: string;
  issuer: string;
  cnfPublicKey: string;
};

export type ProxyRequestVariables = RequestContextVariables & {
  auth?: ProxyAuthContext;
};

export type ProxyAuthMiddlewareOptions = {
  config: ProxyConfig;
  logger: Logger;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  nonceCache?: NonceCache;
  crlCache?: CrlCache;
  maxTimestampSkewSeconds?: number;
  registryKeysCacheTtlMs?: number;
};

type RegistryKeysCache = {
  fetchedAtMs: number;
  keys: VerificationKey[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

function toPathWithQuery(url: string): string {
  const parsed = new URL(url, "http://localhost");
  return `${parsed.pathname}${parsed.search}`;
}

function normalizeRegistryUrl(registryUrl: string): string {
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

function toRegistryUrl(registryUrl: string, path: string): string {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
}

function unauthorizedError(options: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): AppError {
  return new AppError({
    code: options.code,
    message: options.message,
    status: 401,
    details: options.details,
    expose: true,
  });
}

function dependencyUnavailableError(options: {
  message: string;
  details?: Record<string, unknown>;
}): AppError {
  return new AppError({
    code: "PROXY_AUTH_DEPENDENCY_UNAVAILABLE",
    message: options.message,
    status: 503,
    details: options.details,
    expose: true,
  });
}

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

export function resolveExpectedIssuer(registryUrl: string): string | undefined {
  try {
    const hostname = new URL(registryUrl).hostname;
    if (hostname === "api.clawdentity.com") {
      return "https://api.clawdentity.com";
    }

    if (hostname === "dev.api.clawdentity.com") {
      return "https://dev.api.clawdentity.com";
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function parseRegistrySigningKeys(payload: unknown): RegistrySigningKey[] {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) {
    throw dependencyUnavailableError({
      message: "Registry signing keys payload is invalid",
    });
  }

  const parsed = (() => {
    try {
      return parseRegistryConfig({
        ENVIRONMENT: "test",
        REGISTRY_SIGNING_KEYS: JSON.stringify(payload.keys),
      });
    } catch (error) {
      throw dependencyUnavailableError({
        message: "Registry signing keys are invalid",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }
  })();

  const keys = parsed.REGISTRY_SIGNING_KEYS ?? [];
  if (keys.length === 0) {
    throw dependencyUnavailableError({
      message: "Registry signing keys are unavailable",
    });
  }

  return keys;
}

function toVerificationKeys(keys: RegistrySigningKey[]): VerificationKey[] {
  return keys
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

function parseUnixTimestamp(headerValue: string): number {
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

function assertTimestampWithinSkew(options: {
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

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toProofVerificationInput(input: {
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

export function createProxyAuthMiddleware(options: ProxyAuthMiddlewareOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? Date.now;
  const nonceCache = options.nonceCache ?? createNonceCache();
  const maxTimestampSkewSeconds =
    options.maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS;
  const registryKeysCacheTtlMs =
    options.registryKeysCacheTtlMs ?? DEFAULT_REGISTRY_KEYS_CACHE_TTL_MS;
  const registryUrl = normalizeRegistryUrl(options.config.registryUrl);
  const expectedIssuer = resolveExpectedIssuer(registryUrl);

  let registryKeysCache: RegistryKeysCache | undefined;

  async function getActiveRegistryKeys(input?: {
    forceRefresh?: boolean;
  }): Promise<VerificationKey[]> {
    const forceRefresh = input?.forceRefresh === true;
    if (
      !forceRefresh &&
      registryKeysCache &&
      clock() - registryKeysCache.fetchedAtMs <= registryKeysCacheTtlMs
    ) {
      return registryKeysCache.keys;
    }

    let response: Response;
    try {
      response = await fetchImpl(
        toRegistryUrl(registryUrl, "/.well-known/claw-keys.json"),
      );
    } catch (error) {
      throw dependencyUnavailableError({
        message: "Registry signing keys are unavailable",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }

    if (!response.ok) {
      throw dependencyUnavailableError({
        message: "Registry signing keys are unavailable",
        details: {
          status: response.status,
        },
      });
    }

    const parsedKeys = parseRegistrySigningKeys(
      await parseJsonResponse(response),
    );
    const verificationKeys = toVerificationKeys(parsedKeys);
    if (verificationKeys.length === 0) {
      throw dependencyUnavailableError({
        message: "Registry signing keys are unavailable",
      });
    }

    registryKeysCache = {
      fetchedAtMs: clock(),
      keys: verificationKeys,
    };

    return verificationKeys;
  }

  async function fetchLatestCrlClaims(): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(toRegistryUrl(registryUrl, "/v1/crl"));
    } catch (error) {
      throw dependencyUnavailableError({
        message: "Registry CRL is unavailable",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }

    if (!response.ok) {
      throw dependencyUnavailableError({
        message: "Registry CRL is unavailable",
        details: {
          status: response.status,
        },
      });
    }

    const payload = await parseJsonResponse(response);
    if (!isRecord(payload) || typeof payload.crl !== "string") {
      throw dependencyUnavailableError({
        message: "Registry CRL payload is invalid",
      });
    }
    const crlToken = payload.crl;

    const verifyWithKeys = async (registryKeys: VerificationKey[]) =>
      verifyCRL({
        token: crlToken,
        registryKeys,
        expectedIssuer,
      });

    try {
      const verificationKeys = await getActiveRegistryKeys();
      return await verifyWithKeys(verificationKeys);
    } catch (error) {
      if (error instanceof CrlJwtError && error.code === "UNKNOWN_CRL_KID") {
        try {
          const refreshedKeys = await getActiveRegistryKeys({
            forceRefresh: true,
          });
          return await verifyWithKeys(refreshedKeys);
        } catch (refreshedError) {
          throw dependencyUnavailableError({
            message: "Registry CRL is invalid",
            details: {
              reason: toErrorMessage(refreshedError),
            },
          });
        }
      }

      throw dependencyUnavailableError({
        message: "Registry CRL is invalid",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }
  }

  const crlCache =
    options.crlCache ??
    createCrlCache({
      fetchLatest: fetchLatestCrlClaims,
      refreshIntervalMs: options.config.crlRefreshIntervalMs,
      maxAgeMs: options.config.crlMaxAgeMs,
      staleBehavior: options.config.crlStaleBehavior,
      clock,
    });

  async function verifyAitClaims(token: string) {
    const verifyWithKeys = async (registryKeys: VerificationKey[]) =>
      verifyAIT({
        token,
        registryKeys,
        expectedIssuer,
      });

    const verificationKeys = await getActiveRegistryKeys();
    try {
      return await verifyWithKeys(verificationKeys);
    } catch (error) {
      if (error instanceof AitJwtError && error.code === "UNKNOWN_AIT_KID") {
        const refreshedKeys = await getActiveRegistryKeys({
          forceRefresh: true,
        });
        try {
          return await verifyWithKeys(refreshedKeys);
        } catch (refreshedError) {
          throw unauthorizedError({
            code: "PROXY_AUTH_INVALID_AIT",
            message: "AIT verification failed",
            details: {
              reason: toErrorMessage(refreshedError),
            },
          });
        }
      }

      throw unauthorizedError({
        code: "PROXY_AUTH_INVALID_AIT",
        message: "AIT verification failed",
        details: {
          reason: toErrorMessage(error),
        },
      });
    }
  }

  return createMiddleware<{ Variables: ProxyRequestVariables }>(
    async (c, next) => {
      if (c.req.path === "/health") {
        await next();
        return;
      }

      const token = parseClawAuthorizationHeader(c.req.header("authorization"));
      const claims = await verifyAitClaims(token);

      const timestampHeader = c.req.header("x-claw-timestamp");
      if (typeof timestampHeader !== "string") {
        throw unauthorizedError({
          code: "PROXY_AUTH_INVALID_TIMESTAMP",
          message: "X-Claw-Timestamp header is required",
        });
      }

      assertTimestampWithinSkew({
        clock,
        maxSkewSeconds: maxTimestampSkewSeconds,
        timestampSeconds: parseUnixTimestamp(timestampHeader),
      });

      const bodyBytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      const pathWithQuery = toPathWithQuery(c.req.url);

      let cnfPublicKey: Uint8Array;
      try {
        cnfPublicKey = decodeBase64url(claims.cnf.jwk.x);
      } catch (error) {
        throw unauthorizedError({
          code: "PROXY_AUTH_INVALID_AIT",
          message: "AIT public key is invalid",
          details: {
            reason: toErrorMessage(error),
          },
        });
      }

      try {
        await verifyHttpRequest(
          toProofVerificationInput({
            method: c.req.method,
            pathWithQuery,
            headers: c.req.raw.headers,
            body: bodyBytes,
            publicKey: cnfPublicKey,
          }),
        );
      } catch (error) {
        throw unauthorizedError({
          code: "PROXY_AUTH_INVALID_PROOF",
          message: "PoP verification failed",
          details: {
            reason: toErrorMessage(error),
          },
        });
      }

      const nonceHeader = c.req.header("x-claw-nonce");
      const nonce = typeof nonceHeader === "string" ? nonceHeader : "";
      const nonceResult = (() => {
        try {
          return nonceCache.tryAcceptNonce({
            agentDid: claims.sub,
            nonce,
          });
        } catch (error) {
          throw unauthorizedError({
            code: "PROXY_AUTH_INVALID_NONCE",
            message: "Nonce validation failed",
            details: {
              reason: toErrorMessage(error),
            },
          });
        }
      })();

      if (!nonceResult.accepted) {
        throw unauthorizedError({
          code: "PROXY_AUTH_REPLAY",
          message: "Replay detected",
        });
      }

      let isRevoked: boolean;
      try {
        isRevoked = await crlCache.isRevoked(claims.jti);
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === "PROXY_AUTH_DEPENDENCY_UNAVAILABLE"
        ) {
          throw error;
        }

        throw dependencyUnavailableError({
          message: "Registry CRL is unavailable",
          details: {
            reason: toErrorMessage(error),
          },
        });
      }

      if (isRevoked) {
        throw unauthorizedError({
          code: "PROXY_AUTH_REVOKED",
          message: "AIT has been revoked",
        });
      }

      c.set("auth", {
        agentDid: claims.sub,
        ownerDid: claims.ownerDid,
        aitJti: claims.jti,
        issuer: claims.iss,
        cnfPublicKey: claims.cnf.jwk.x,
      });

      options.logger.info("proxy.auth.verified", {
        agentDid: claims.sub,
        ownerDid: claims.ownerDid,
        jti: claims.jti,
      });

      await next();
    },
  );
}
