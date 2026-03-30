import { ProtocolParseError } from "./errors.js";
import { parseUlid } from "./ulid.js";

export type DidEntity = "human" | "agent";

export type ParsedDid = {
  method: "cdi";
  authority: string;
  entity: DidEntity;
  ulid: string;
};

const DID_METHOD = "cdi" as const;
const MAX_AUTHORITY_LENGTH = 253;
const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GROUP_ID_PREFIX = "grp_";

function invalidDid(value: string): ProtocolParseError {
  return new ProtocolParseError("INVALID_DID", `Invalid DID: ${value}`);
}

function invalidGroupId(value: string): ProtocolParseError {
  return new ProtocolParseError(
    "INVALID_GROUP_ID",
    `Invalid group ID: ${value}`,
  );
}

function ensureDidUlid(value: string, didValue: string): void {
  try {
    parseUlid(value);
  } catch {
    throw invalidDid(didValue);
  }
}

function ensureDidAuthority(authority: string, didValue: string): void {
  if (authority.length === 0 || authority.length > MAX_AUTHORITY_LENGTH) {
    throw invalidDid(didValue);
  }

  const labels = authority.split(".");
  if (labels.length < 2) {
    throw invalidDid(didValue);
  }

  for (const label of labels) {
    if (!DNS_LABEL_REGEX.test(label)) {
      throw invalidDid(didValue);
    }
  }
}

function makeDid(authority: string, entity: DidEntity, id: string): string {
  const didValue = `did:${DID_METHOD}:${authority}:${entity}:${id}`;
  ensureDidAuthority(authority, didValue);
  ensureDidUlid(id, didValue);
  return didValue;
}

export function makeHumanDid(authority: string, id: string): string {
  return makeDid(authority, "human", id);
}

export function makeAgentDid(authority: string, id: string): string {
  return makeDid(authority, "agent", id);
}

export function parseDid(value: string): ParsedDid {
  const parts = value.split(":");
  if (parts.length !== 5) {
    throw invalidDid(value);
  }

  const [scheme, method, rawAuthority, rawEntity, rawUlid] = parts;
  if (scheme !== "did" || method !== DID_METHOD) {
    throw invalidDid(value);
  }

  ensureDidAuthority(rawAuthority, value);

  if (rawEntity !== "human" && rawEntity !== "agent") {
    throw invalidDid(value);
  }

  ensureDidUlid(rawUlid, value);

  return {
    method: DID_METHOD,
    authority: rawAuthority,
    entity: rawEntity,
    ulid: rawUlid,
  };
}

export function parseAgentDid(value: string): ParsedDid & { entity: "agent" } {
  const parsed = parseDid(value);
  if (parsed.entity !== "agent") {
    throw invalidDid(value);
  }

  return {
    ...parsed,
    entity: "agent",
  };
}

export function parseHumanDid(value: string): ParsedDid & { entity: "human" } {
  const parsed = parseDid(value);
  if (parsed.entity !== "human") {
    throw invalidDid(value);
  }

  return {
    ...parsed,
    entity: "human",
  };
}

export function parseGroupId(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith(GROUP_ID_PREFIX)) {
    throw invalidGroupId(value);
  }

  const ulid = normalized.slice(GROUP_ID_PREFIX.length);
  try {
    parseUlid(ulid);
  } catch {
    throw invalidGroupId(value);
  }

  return normalized;
}
