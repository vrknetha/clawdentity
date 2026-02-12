import type { AitClaims, AitCnfJwk } from "@clawdentity/protocol";
import { parseAitClaims } from "@clawdentity/protocol";
import type { JWTVerifyOptions } from "jose";
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from "jose";
import {
  type Ed25519KeypairBytes,
  encodeEd25519KeypairBase64url,
} from "../crypto/ed25519.js";

type AitPrivateJwk = AitCnfJwk & {
  d: string;
};

export type RegistryAitVerificationKey = {
  kid: string;
  jwk: AitCnfJwk;
};

export type SignAitInput = {
  claims: AitClaims;
  signerKid: string;
  signerKeypair: Ed25519KeypairBytes;
};

export type VerifyAitInput = {
  token: string;
  registryKeys: RegistryAitVerificationKey[];
  expectedIssuer?: string;
};

export class AitJwtError extends Error {
  readonly code: "INVALID_AIT_HEADER" | "UNKNOWN_AIT_KID";

  constructor(code: "INVALID_AIT_HEADER" | "UNKNOWN_AIT_KID", message: string) {
    super(message);
    this.name = "AitJwtError";
    this.code = code;
  }
}

function invalidAitHeader(message: string): AitJwtError {
  return new AitJwtError("INVALID_AIT_HEADER", message);
}

function unknownAitKid(kid: string): AitJwtError {
  return new AitJwtError("UNKNOWN_AIT_KID", `Unknown AIT signing kid: ${kid}`);
}

export async function signAIT(input: SignAitInput): Promise<string> {
  const claims = parseAitClaims(input.claims);
  const encodedKeypair = encodeEd25519KeypairBase64url(input.signerKeypair);
  const privateJwk: AitPrivateJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: encodedKeypair.publicKey,
    d: encodedKeypair.secretKey,
  };
  const privateKey = await importJWK(privateJwk, "EdDSA");

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "EdDSA",
      typ: "AIT",
      kid: input.signerKid,
    })
    .sign(privateKey);
}

export async function verifyAIT(input: VerifyAitInput): Promise<AitClaims> {
  const header = decodeProtectedHeader(input.token);
  if (header.alg !== "EdDSA") {
    throw invalidAitHeader("AIT token must use alg=EdDSA");
  }

  if (header.typ !== "AIT") {
    throw invalidAitHeader("AIT token must use typ=AIT");
  }

  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw invalidAitHeader("AIT token missing protected kid header");
  }

  const key = input.registryKeys.find((item) => item.kid === header.kid);
  if (!key) {
    throw unknownAitKid(header.kid);
  }

  const publicKey = await importJWK(key.jwk, "EdDSA");
  const options: JWTVerifyOptions = {
    algorithms: ["EdDSA"],
    typ: "AIT",
  };

  if (input.expectedIssuer !== undefined) {
    options.issuer = input.expectedIssuer;
  }

  const { payload } = await jwtVerify(input.token, publicKey, options);
  return parseAitClaims(payload);
}
