import {
  type AitClaims,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";

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
const DEFAULT_ISSUER = "https://api.clawdentity.com";
const DEFAULT_NAME = "Proxy Agent";
const DEFAULT_FRAMEWORK = "openclaw";
const DEFAULT_DESCRIPTION = "test agent";
const DEFAULT_TTL_SECONDS = 600;

export function buildTestAitClaims(input: BuildTestAitClaimsInput): AitClaims {
  const seedMs = input.seedMs ?? DEFAULT_SEED_MS;
  const nowSeconds =
    input.nowSeconds ?? Math.floor((input.seedMs ?? Date.now()) / 1000);
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const nbfSkewSeconds = input.nbfSkewSeconds ?? 5;

  return {
    iss: input.issuer ?? DEFAULT_ISSUER,
    sub: makeAgentDid(generateUlid(seedMs + 10)),
    ownerDid: makeHumanDid(generateUlid(seedMs + 20)),
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
