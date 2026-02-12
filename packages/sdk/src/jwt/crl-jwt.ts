import {
  type CrlClaims as ProtocolCrlClaims,
  parseCrlClaims,
} from "@clawdentity/protocol";
import type { JWTVerifyOptions } from "jose";
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from "jose";
import type { Ed25519KeypairBytes } from "../crypto/ed25519.js";
import { encodeEd25519KeypairBase64url } from "../crypto/ed25519.js";

export type CrlClaims = ProtocolCrlClaims;

type CrlPublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
};

type CrlPrivateJwk = CrlPublicJwk & {
  d: string;
};

export type RegistryCrlVerificationKey = {
  kid: string;
  jwk: CrlPublicJwk;
};

export type SignCrlInput = {
  claims: CrlClaims;
  signerKid: string;
  signerKeypair: Ed25519KeypairBytes;
};

export type VerifyCrlInput = {
  token: string;
  registryKeys: RegistryCrlVerificationKey[];
  expectedIssuer?: string;
};

export class CrlJwtError extends Error {
  readonly code: "INVALID_CRL_HEADER" | "UNKNOWN_CRL_KID";

  constructor(code: "INVALID_CRL_HEADER" | "UNKNOWN_CRL_KID", message: string) {
    super(message);
    this.name = "CrlJwtError";
    this.code = code;
  }
}

function invalidCrlHeader(message: string): CrlJwtError {
  return new CrlJwtError("INVALID_CRL_HEADER", message);
}

function unknownCrlKid(kid: string): CrlJwtError {
  return new CrlJwtError("UNKNOWN_CRL_KID", `Unknown CRL signing kid: ${kid}`);
}

export async function signCRL(input: SignCrlInput): Promise<string> {
  const claims = parseCrlClaims(input.claims);
  const encodedKeypair = encodeEd25519KeypairBase64url(input.signerKeypair);
  const privateJwk: CrlPrivateJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: encodedKeypair.publicKey,
    d: encodedKeypair.secretKey,
  };
  const privateKey = await importJWK(privateJwk, "EdDSA");

  return new SignJWT(claims)
    .setProtectedHeader({
      alg: "EdDSA",
      typ: "CRL",
      kid: input.signerKid,
    })
    .sign(privateKey);
}

export async function verifyCRL(input: VerifyCrlInput): Promise<CrlClaims> {
  const header = decodeProtectedHeader(input.token);
  if (header.alg !== "EdDSA") {
    throw invalidCrlHeader("CRL token must use alg=EdDSA");
  }

  if (header.typ !== "CRL") {
    throw invalidCrlHeader("CRL token must use typ=CRL");
  }

  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw invalidCrlHeader("CRL token missing protected kid header");
  }

  const key = input.registryKeys.find((entry) => entry.kid === header.kid);
  if (!key) {
    throw unknownCrlKid(header.kid);
  }

  const publicKey = await importJWK(key.jwk, "EdDSA");
  const options: JWTVerifyOptions = {
    algorithms: ["EdDSA"],
    typ: "CRL",
  };

  if (input.expectedIssuer !== undefined) {
    options.issuer = input.expectedIssuer;
  }

  const { payload } = await jwtVerify(input.token, publicKey, options);
  return parseCrlClaims(payload);
}
