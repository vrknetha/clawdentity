export type ProtocolParseErrorCode =
  | "INVALID_AIT_CLAIMS"
  | "INVALID_BASE64URL"
  | "INVALID_ULID"
  | "INVALID_DID"
  | "INVALID_GROUP_ID"
  | "INVALID_CRL_CLAIMS";

export class ProtocolParseError extends Error {
  readonly code: ProtocolParseErrorCode;

  constructor(code: ProtocolParseErrorCode, message: string) {
    super(message);
    this.name = "ProtocolParseError";
    this.code = code;
  }
}
