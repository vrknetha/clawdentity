import { decodeTime, isValid, ulid } from "ulid";
import { ProtocolParseError } from "./errors.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function invalidUlid(value: string): ProtocolParseError {
  return new ProtocolParseError("INVALID_ULID", `Invalid ULID: ${value}`);
}

export function generateUlid(now?: number): string {
  return now === undefined ? ulid() : ulid(now);
}

export function parseUlid(value: string): {
  value: string;
  timestampMs: number;
} {
  if (!ULID_PATTERN.test(value) || !isValid(value)) {
    throw invalidUlid(value);
  }

  return {
    value,
    timestampMs: decodeTime(value),
  };
}
