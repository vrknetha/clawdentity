import { ProtocolParseError } from "./errors.js";
import { parseUlid } from "./ulid.js";

export type ClawDidKind = "human" | "agent";

function invalidDid(value: string): ProtocolParseError {
  return new ProtocolParseError("INVALID_DID", `Invalid DID: ${value}`);
}

function ensureDidUlid(value: string): void {
  try {
    parseUlid(value);
  } catch {
    throw invalidDid(value);
  }
}

function makeDid(kind: ClawDidKind, id: string): string {
  ensureDidUlid(id);
  return `did:claw:${kind}:${id}`;
}

export function makeHumanDid(id: string): string {
  return makeDid("human", id);
}

export function makeAgentDid(id: string): string {
  return makeDid("agent", id);
}

export function parseDid(value: string): { kind: ClawDidKind; ulid: string } {
  const parts = value.split(":");
  if (parts.length !== 4) {
    throw invalidDid(value);
  }

  const [scheme, method, rawKind, rawUlid] = parts;
  if (scheme !== "did" || method !== "claw") {
    throw invalidDid(value);
  }

  if (rawKind !== "human" && rawKind !== "agent") {
    throw invalidDid(value);
  }

  ensureDidUlid(rawUlid);

  return {
    kind: rawKind,
    ulid: rawUlid,
  };
}
