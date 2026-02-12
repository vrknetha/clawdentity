import { base64urlnopad } from "@scure/base";
import { ProtocolParseError } from "./errors.js";

function invalidBase64url(input: string): ProtocolParseError {
  return new ProtocolParseError(
    "INVALID_BASE64URL",
    `Invalid base64url input: ${input}`,
  );
}

export function encodeBase64url(input: Uint8Array): string {
  return base64urlnopad.encode(input);
}

export function decodeBase64url(input: string): Uint8Array {
  if (input.length === 0) {
    return new Uint8Array();
  }

  try {
    return base64urlnopad.decode(input);
  } catch {
    throw invalidBase64url(input);
  }
}
