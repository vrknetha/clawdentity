export const PROTOCOL_VERSION = "0.0.0";

export type { AgentRegistrationProofMessageInput } from "./agent-registration-proof.js";
export {
  AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE,
  AGENT_REGISTRATION_PROOF_VERSION,
  canonicalizeAgentRegistrationProof,
} from "./agent-registration-proof.js";
export type { AitClaims, AitCnfJwk } from "./ait.js";
export {
  AGENT_NAME_REGEX,
  aitClaimsSchema,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  parseAitClaims,
  validateAgentName,
} from "./ait.js";
export { decodeBase64url, encodeBase64url } from "./base64url.js";
export type { CrlClaims } from "./crl.js";
export { crlClaimsSchema, parseCrlClaims } from "./crl.js";
export type { ClawDidKind } from "./did.js";
export { makeAgentDid, makeHumanDid, parseDid } from "./did.js";
export type { EncryptedRelayPayloadV1 } from "./e2ee.js";
export {
  encryptedRelayPayloadV1Schema,
  parseEncryptedRelayPayloadV1,
} from "./e2ee.js";
export {
  ADMIN_BOOTSTRAP_PATH,
  ADMIN_INTERNAL_SERVICES_PATH,
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_VALIDATE_PATH,
  AGENT_REGISTRATION_CHALLENGE_PATH,
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  ME_API_KEYS_PATH,
  REGISTRY_METADATA_PATH,
  RELAY_CONNECT_PATH,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
} from "./endpoints.js";
export type { ProtocolParseErrorCode } from "./errors.js";
export { ProtocolParseError } from "./errors.js";
export type { CanonicalRequestInput } from "./http-signing.js";
export {
  CLAW_PROOF_CANONICAL_VERSION,
  canonicalizeRequest,
} from "./http-signing.js";
export { generateUlid, parseUlid } from "./ulid.js";
