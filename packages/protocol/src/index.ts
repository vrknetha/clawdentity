export const PROTOCOL_VERSION = "0.0.0";

export { decodeBase64url, encodeBase64url } from "./base64url.js";
export type { ClawDidKind } from "./did.js";
export { makeAgentDid, makeHumanDid, parseDid } from "./did.js";
export type { ProtocolParseErrorCode } from "./errors.js";
export { ProtocolParseError } from "./errors.js";
export { generateUlid, parseUlid } from "./ulid.js";
