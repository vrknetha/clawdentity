import { parseJsonResponseSafe as parseJsonResponse } from "@clawdentity/common";
import {
  AGENT_AUTH_VALIDATE_PATH,
  decodeBase64url,
  RELAY_CONNECT_PATH,
  RELAY_DELIVERY_RECEIPTS_PATH,
} from "@clawdentity/protocol";
import {
  AitJwtError,
  AppError,
  CrlJwtError,
  createCrlCache,
  createNonceCache,
  verifyAIT,
  verifyCRL,
  verifyHttpRequest,
} from "@clawdentity/sdk";
import { createMiddleware } from "hono/factory";
import { assertKnownTrustedAgent } from "../trust-policy.js";
import {
  dependencyUnavailableError,
  toErrorMessage,
  unauthorizedError,
} from "./errors.js";
import {
  parseRegistrySigningKeys,
  toVerificationKeys,
} from "./registry-keys.js";
import {
  assertTimestampWithinSkew,
  parseAgentAccessHeader,
  parseClawAuthorizationHeader,
  parseUnixTimestamp,
  toProofVerificationInput,
} from "./request-auth.js";
import {
  DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  DEFAULT_REGISTRY_KEYS_CACHE_TTL_MS,
  type ProxyAuthMiddlewareOptions,
  type ProxyRequestVariables,
  type RegistryKeysCache,
  type VerificationKey,
} from "./types.js";
import {
  isLoopbackRegistryUrl,
  normalizeRegistryUrl,
  resolveExpectedIssuer,
  shouldSkipKnownAgentCheck,
  toPathWithQuery,
  toRegistryUrl,
} from "./url.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createProxyAuthMiddleware(options: ProxyAuthMiddlewareOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? Date.now;
  const maxTimestampSkewSeconds =
    options.maxTimestampSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS;
  const nonceCache =
    options.nonceCache ??
    createNonceCache({
      clock,
      ttlMs: maxTimestampSkewSeconds * 1000,
    });
  const registryKeysCacheTtlMs =
    options.registryKeysCacheTtlMs ?? DEFAULT_REGISTRY_KEYS_CACHE_TTL_MS;
  const registryUrl = normalizeRegistryUrl(options.config.registryUrl);
  const crlExpectedIssuer = isLoopbackRegistryUrl(registryUrl)
    ? undefined
    : resolveExpectedIssuer(registryUrl);
  const agentAuthValidateUrl = toRegistryUrl(
    registryUrl,
    AGENT_AUTH_VALIDATE_PATH,
  );

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
        expectedIssuer: crlExpectedIssuer,
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

  async function verifyAitClaims(token: string, request: Request) {
    const expectedIssuer = resolveExpectedIssuer(registryUrl, request);
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
      const authorizationHeader = c.req.header("authorization");
      const token = parseClawAuthorizationHeader(authorizationHeader);
      const claims = await verifyAitClaims(token, c.req.raw);

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
      const nonceResult = await (async () => {
        try {
          return await nonceCache.tryAcceptNonce({
            agentDid: claims.sub,
            nonce,
            ttlMs: maxTimestampSkewSeconds * 1000,
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

      if (!shouldSkipKnownAgentCheck(c.req.path)) {
        await assertKnownTrustedAgent({
          trustStore: options.trustStore,
          agentDid: claims.sub,
        });
      }

      if (
        c.req.path === "/hooks/agent" ||
        c.req.path === RELAY_CONNECT_PATH ||
        c.req.path === RELAY_DELIVERY_RECEIPTS_PATH
      ) {
        const accessToken = parseAgentAccessHeader(
          c.req.header("x-claw-agent-access"),
        );

        let validateResponse: Response;
        try {
          validateResponse = await fetchImpl(agentAuthValidateUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-claw-agent-access": accessToken,
            },
            body: JSON.stringify({
              agentDid: claims.sub,
              aitJti: claims.jti,
            }),
          });
        } catch (error) {
          throw dependencyUnavailableError({
            message: "Registry agent auth validation is unavailable",
            details: {
              reason: toErrorMessage(error),
            },
          });
        }

        if (validateResponse.status === 401) {
          throw unauthorizedError({
            code: "PROXY_AGENT_ACCESS_INVALID",
            message: "Agent access token is invalid or expired",
          });
        }

        if (validateResponse.status !== 204) {
          throw dependencyUnavailableError({
            message: "Registry agent auth validation is unavailable",
            details: {
              status: validateResponse.status,
            },
          });
        }
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
