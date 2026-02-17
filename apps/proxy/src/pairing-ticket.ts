import {
  decodeBase64url,
  encodeBase64url,
  generateUlid,
} from "@clawdentity/protocol";

const PAIRING_TICKET_PREFIX = "clwpair1_";
const PAIRING_TICKET_VERSION = 1;
const TICKET_NONCE_BYTES = 18;

export type PairingTicketPayload = {
  v: number;
  iss: string;
  kid: string;
  nonce: string;
  exp: number;
};

export class PairingTicketParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PairingTicketParseError";
    this.code = code;
  }
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function utf8Decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_ISSUER",
      "Pairing ticket issuer URL is invalid",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_ISSUER",
      "Pairing ticket issuer URL is invalid",
    );
  }

  return parsed.origin;
}

function createRandomNonce(): string {
  const bytes = new Uint8Array(TICKET_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase64url(bytes);
}

export function createPairingTicket(input: {
  issuerProxyUrl: string;
  expiresAtMs: number;
  nowMs: number;
}): {
  ticket: string;
  payload: PairingTicketPayload;
} {
  const payload: PairingTicketPayload = {
    v: PAIRING_TICKET_VERSION,
    iss: assertHttpUrl(input.issuerProxyUrl),
    kid: generateUlid(input.nowMs),
    nonce: createRandomNonce(),
    exp: Math.floor(input.expiresAtMs / 1000),
  };

  const encodedPayload = encodeBase64url(utf8Encode(JSON.stringify(payload)));

  return {
    ticket: `${PAIRING_TICKET_PREFIX}${encodedPayload}`,
    payload,
  };
}

export function parsePairingTicket(ticket: string): PairingTicketPayload {
  const trimmedTicket = ticket.trim();
  if (!trimmedTicket.startsWith(PAIRING_TICKET_PREFIX)) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  const encodedPayload = trimmedTicket.slice(PAIRING_TICKET_PREFIX.length);
  if (encodedPayload.length === 0) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(utf8Decode(decodeBase64url(encodedPayload)));
  } catch {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  if (!isRecord(payload)) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  if (payload.v !== PAIRING_TICKET_VERSION) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_UNSUPPORTED_VERSION",
      "Pairing ticket version is not supported",
    );
  }

  if (typeof payload.kid !== "string" || payload.kid.trim().length === 0) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  if (typeof payload.nonce !== "string" || payload.nonce.trim().length === 0) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  return {
    v: PAIRING_TICKET_VERSION,
    iss: assertHttpUrl(payload.iss as string),
    kid: payload.kid.trim(),
    nonce: payload.nonce.trim(),
    exp: payload.exp,
  };
}
