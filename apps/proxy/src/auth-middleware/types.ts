import type {
  CrlCache,
  Logger,
  NonceCacheInput,
  NonceCacheResult,
  RequestContextVariables,
} from "@clawdentity/sdk";
import type { ProxyConfig } from "../config.js";
import type { ProxyTrustStore } from "../proxy-trust-store.js";

export const DEFAULT_REGISTRY_KEYS_CACHE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type RegistrySigningKey = {
  kid: string;
  alg: "EdDSA";
  crv: "Ed25519";
  x: string;
  status: "active" | "revoked";
};

export type VerificationKey = {
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

export type ProxyNonceCacheInput = NonceCacheInput & {
  ttlMs?: number;
  nowMs?: number;
};

export type ProxyNonceCacheResult = NonceCacheResult;

export interface ProxyNonceCache {
  tryAcceptNonce(
    input: ProxyNonceCacheInput,
  ): ProxyNonceCacheResult | Promise<ProxyNonceCacheResult>;
  purgeExpired?: () => void | Promise<void>;
}

export type ProxyAuthMiddlewareOptions = {
  config: ProxyConfig;
  logger: Logger;
  trustStore: ProxyTrustStore;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  nonceCache?: ProxyNonceCache;
  crlCache?: CrlCache;
  maxTimestampSkewSeconds?: number;
  registryKeysCacheTtlMs?: number;
};

export type RegistryKeysCache = {
  fetchedAtMs: number;
  keys: VerificationKey[];
};
