import {
  type AitClaims,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { nowUtcMs } from "../datetime.js";

export type BuildTestAitClaimsInput = {
  publicKeyX: string;
  issuer?: string;
  nowSeconds?: number;
  seedMs?: number;
  ttlSeconds?: number;
  nbfSkewSeconds?: number;
  name?: string;
  framework?: string;
  description?: string;
};

const DEFAULT_SEED_MS = 1_700_000_000_000;
const DEFAULT_ISSUER = "https://registry.clawdentity.com";
const DEFAULT_NAME = "Proxy Agent";
const DEFAULT_FRAMEWORK = "openclaw";
const DEFAULT_DESCRIPTION = "test agent";
const DEFAULT_TTL_SECONDS = 600;

function issuerToAuthority(issuer: string): string {
  const match = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(issuer);
  if (match === null) {
    throw new Error("issuer must be a URL with a hostname");
  }

  const authoritySegment = match[1];
  if (authoritySegment.includes("@") || authoritySegment.startsWith("[")) {
    throw new Error("issuer must include a DNS hostname");
  }

  const [hostname, rawPort, ...rest] = authoritySegment.split(":");
  if (
    hostname.length === 0 ||
    rest.length > 0 ||
    (typeof rawPort === "string" &&
      rawPort.length > 0 &&
      !/^[0-9]+$/.test(rawPort))
  ) {
    throw new Error("issuer must include a DNS hostname");
  }

  return hostname.toLowerCase();
}

export function buildTestAitClaims(input: BuildTestAitClaimsInput): AitClaims {
  const seedMs = input.seedMs ?? DEFAULT_SEED_MS;
  const nowSeconds =
    input.nowSeconds ?? Math.floor((input.seedMs ?? nowUtcMs()) / 1000);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const nbfSkewSeconds = input.nbfSkewSeconds ?? 5;
  const issuer = input.issuer ?? DEFAULT_ISSUER;
  const issuerAuthority = issuerToAuthority(issuer);

  return {
    iss: issuer,
    sub: makeAgentDid(issuerAuthority, generateUlid(seedMs + 10)),
    ownerDid: makeHumanDid(issuerAuthority, generateUlid(seedMs + 20)),
    name: input.name ?? DEFAULT_NAME,
    framework: input.framework ?? DEFAULT_FRAMEWORK,
    description: input.description ?? DEFAULT_DESCRIPTION,
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: input.publicKeyX,
      },
    },
    iat: nowSeconds,
    nbf: nowSeconds - nbfSkewSeconds,
    exp: nowSeconds + ttlSeconds,
    jti: generateUlid(seedMs + 30),
  };
}
