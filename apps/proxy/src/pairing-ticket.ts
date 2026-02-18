import {
  decodeBase64url,
  encodeBase64url,
  generateUlid,
} from "@clawdentity/protocol";

const PAIRING_TICKET_PREFIX = "clwpair1_";
const PAIRING_TICKET_VERSION = 2;
const TICKET_NONCE_BYTES = 18;

type PairingTicketUnsignedPayload = {
  v: number;
  iss: string;
  kid: string;
  nonce: string;
  exp: number;
  pkid: string;
};

export type PairingTicketPayload = PairingTicketUnsignedPayload & {
  sig: string;
};

export type PairingTicketSigningKey = {
  pkid: string;
  privateKey: CryptoKey;
  publicKeyX: string;
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

function canonicalizePairingTicketPayload(
  payload: PairingTicketUnsignedPayload,
): string {
  return JSON.stringify({
    v: payload.v,
    iss: payload.iss,
    kid: payload.kid,
    nonce: payload.nonce,
    exp: payload.exp,
    pkid: payload.pkid,
  });
}

function toUnsignedPayload(
  payload: PairingTicketPayload,
): PairingTicketUnsignedPayload {
  return {
    v: payload.v,
    iss: payload.iss,
    kid: payload.kid,
    nonce: payload.nonce,
    exp: payload.exp,
    pkid: payload.pkid,
  };
}

function normalizeNonEmptyString(
  value: unknown,
  code: string,
  message: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PairingTicketParseError(code, message);
  }

  return value.trim();
}

async function importVerifyKeyFromX(publicKeyX: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      x: publicKeyX,
    },
    {
      name: "Ed25519",
    },
    false,
    ["verify"],
  );
}

export async function createPairingTicketSigningKey(input: {
  nowMs: number;
}): Promise<PairingTicketSigningKey> {
  const generated = (await crypto.subtle.generateKey(
    {
      name: "Ed25519",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    generated.publicKey,
  )) as JsonWebKey;
  if (typeof publicJwk.x !== "string" || publicJwk.x.trim().length === 0) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_KEY_EXPORT_FAILED",
      "Pairing ticket signing key export failed",
    );
  }

  return {
    pkid: generateUlid(input.nowMs),
    privateKey: generated.privateKey,
    publicKeyX: publicJwk.x,
  };
}

export async function createPairingTicket(input: {
  issuerProxyUrl: string;
  expiresAtMs: number;
  nowMs: number;
  signingKey: {
    pkid: string;
    privateKey: CryptoKey;
  };
}): Promise<{
  ticket: string;
  payload: PairingTicketPayload;
}> {
  const payload: PairingTicketUnsignedPayload = {
    v: PAIRING_TICKET_VERSION,
    iss: assertHttpUrl(input.issuerProxyUrl),
    kid: generateUlid(input.nowMs),
    nonce: createRandomNonce(),
    exp: Math.floor(input.expiresAtMs / 1000),
    pkid: normalizeNonEmptyString(
      input.signingKey.pkid,
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    ),
  };

  const signatureBuffer = await crypto.subtle.sign(
    {
      name: "Ed25519",
    },
    input.signingKey.privateKey,
    utf8Encode(canonicalizePairingTicketPayload(payload)),
  );
  const signedPayload: PairingTicketPayload = {
    ...payload,
    sig: encodeBase64url(new Uint8Array(signatureBuffer)),
  };

  const encodedPayload = encodeBase64url(
    utf8Encode(JSON.stringify(signedPayload)),
  );
  return {
    ticket: `${PAIRING_TICKET_PREFIX}${encodedPayload}`,
    payload: signedPayload,
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

  const iss = assertHttpUrl(String(payload.iss ?? ""));
  const kid = normalizeNonEmptyString(
    payload.kid,
    "PROXY_PAIR_TICKET_INVALID_FORMAT",
    "Pairing ticket format is invalid",
  );
  const nonce = normalizeNonEmptyString(
    payload.nonce,
    "PROXY_PAIR_TICKET_INVALID_FORMAT",
    "Pairing ticket format is invalid",
  );
  const pkid = normalizeNonEmptyString(
    payload.pkid,
    "PROXY_PAIR_TICKET_INVALID_FORMAT",
    "Pairing ticket format is invalid",
  );
  const sig = normalizeNonEmptyString(
    payload.sig,
    "PROXY_PAIR_TICKET_INVALID_FORMAT",
    "Pairing ticket format is invalid",
  );
  if (typeof payload.exp !== "number" || !Number.isInteger(payload.exp)) {
    throw new PairingTicketParseError(
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    );
  }

  return {
    v: PAIRING_TICKET_VERSION,
    iss,
    kid,
    nonce,
    exp: payload.exp,
    pkid,
    sig,
  };
}

export async function verifyPairingTicketSignature(input: {
  payload: PairingTicketPayload;
  publicKeyX: string;
}): Promise<boolean> {
  const verifyKey = await importVerifyKeyFromX(
    normalizeNonEmptyString(
      input.publicKeyX,
      "PROXY_PAIR_TICKET_INVALID_FORMAT",
      "Pairing ticket format is invalid",
    ),
  );

  let signature: Uint8Array;
  try {
    signature = decodeBase64url(input.payload.sig);
  } catch {
    return false;
  }

  return crypto.subtle.verify(
    {
      name: "Ed25519",
    },
    verifyKey,
    signature,
    utf8Encode(
      canonicalizePairingTicketPayload(toUnsignedPayload(input.payload)),
    ),
  );
}
