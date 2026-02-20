export const SDK_VERSION = "0.0.0";

export type { AgentAuthBundle } from "./agent-auth-client.js";
export {
  executeWithAgentAuthRefreshRetry,
  isRetryableAuthExpiryError,
  refreshAgentAuthWithClawProof,
} from "./agent-auth-client.js";
export type { RegistryConfig } from "./config.js";
export { parseRegistryConfig, registryConfigSchema } from "./config.js";
export type {
  CrlCache,
  CrlCacheOptions,
  CrlCacheRefreshResult,
  CrlCacheStaleBehavior,
  CrlCacheWarning,
} from "./crl/cache.js";
export {
  createCrlCache,
  DEFAULT_CRL_MAX_AGE_MS,
  DEFAULT_CRL_REFRESH_INTERVAL_MS,
} from "./crl/cache.js";
export {
  decodeCanonicalJson,
  decryptXChaCha20Poly1305,
  encodeCanonicalJson,
  encryptXChaCha20Poly1305,
} from "./crypto/e2ee.js";
export type {
  Ed25519KeypairBase64url,
  Ed25519KeypairBytes,
} from "./crypto/ed25519.js";
export {
  decodeEd25519KeypairBase64url,
  decodeEd25519SignatureBase64url,
  deriveEd25519PublicKey,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  signEd25519,
  verifyEd25519,
} from "./crypto/ed25519.js";
export { hkdfSha256, hmacSha256, sha256, zeroBytes } from "./crypto/hkdf.js";
export type {
  X25519KeypairBase64url,
  X25519KeypairBytes,
} from "./crypto/x25519.js";
export {
  decodeX25519KeypairBase64url,
  deriveX25519PublicKey,
  deriveX25519SharedSecret,
  encodeX25519KeypairBase64url,
  generateX25519Keypair,
} from "./crypto/x25519.js";
export { addSeconds, isExpired, nowIso } from "./datetime.js";
export type {
  EventBus,
  EventEnvelope,
  EventEnvelopeInput,
  EventHandler,
  InMemoryEventBus,
  QueuePublisher,
} from "./event-bus.js";
export {
  createEventEnvelope,
  createInMemoryEventBus,
  createQueueEventBus,
} from "./event-bus.js";
export {
  AppError,
  createHonoErrorHandler,
  toErrorEnvelope,
} from "./exceptions.js";
export { signHttpRequest } from "./http/sign.js";
export type {
  ClawSignatureHeaders,
  SignHttpRequestInput,
  SignHttpRequestResult,
  VerifyHttpRequestInput,
  VerifyHttpRequestResult,
} from "./http/types.js";
export { verifyHttpRequest } from "./http/verify.js";
export type {
  DecodedAit,
  DecodedAitHeader,
  RegistryAitVerificationKey,
  SignAitInput,
  VerifyAitInput,
} from "./jwt/ait-jwt.js";
export { AitJwtError, decodeAIT, signAIT, verifyAIT } from "./jwt/ait-jwt.js";
export type {
  CrlClaims,
  RegistryCrlVerificationKey,
  SignCrlInput,
  VerifyCrlInput,
} from "./jwt/crl-jwt.js";
export { CrlJwtError, signCRL, verifyCRL } from "./jwt/crl-jwt.js";
export type { Logger } from "./logging.js";
export { createLogger, createRequestLoggingMiddleware } from "./logging.js";
export type { AgentOwnershipResult } from "./registry-identity-client.js";
export {
  createRegistryIdentityClient,
  INTERNAL_SERVICE_ID_HEADER,
  INTERNAL_SERVICE_SECRET_HEADER,
} from "./registry-identity-client.js";
export type { RequestContextVariables } from "./request-context.js";
export {
  createRequestContextMiddleware,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-context.js";
export type { RuntimeEnvironment } from "./runtime-environment.js";
export { shouldExposeVerboseErrors } from "./runtime-environment.js";
export type {
  NonceCache,
  NonceCacheInput,
  NonceCacheOptions,
  NonceCacheResult,
} from "./security/nonce-cache.js";
export {
  createNonceCache,
  DEFAULT_NONCE_TTL_MS,
} from "./security/nonce-cache.js";
