export const PROTOCOL_VERSION = "0.0.0";

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
export type { ClawDidKind } from "./did.js";
export { makeAgentDid, makeHumanDid, parseDid } from "./did.js";
export type { ProtocolParseErrorCode } from "./errors.js";
export { ProtocolParseError } from "./errors.js";
export type { CanonicalRequestInput } from "./http-signing.js";
export {
  CLAW_PROOF_CANONICAL_VERSION,
  canonicalizeRequest,
} from "./http-signing.js";
export { generateUlid, parseUlid } from "./ulid.js";
