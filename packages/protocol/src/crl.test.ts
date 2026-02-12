import { describe, expect, it } from "vitest";
import { parseCrlClaims } from "./crl.js";
import { makeAgentDid, makeHumanDid } from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { generateUlid } from "./ulid.js";

function makeValidCrlClaims() {
  const now = 1700000000;
  const agentUlid = generateUlid(1700000000000);

  return {
    iss: "https://registry.clawdentity.dev",
    jti: generateUlid(1700000100000),
    iat: now,
    exp: now + 3600,
    revocations: [
      {
        jti: generateUlid(1700000200000),
        agentDid: makeAgentDid(agentUlid),
        reason: "key compromise",
        revokedAt: now + 1000,
      },
    ],
  };
}

function expectInvalidCrl(payload: unknown) {
  try {
    parseCrlClaims(payload);
    throw new Error("parseCrlClaims was expected to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolParseError);
    if (error instanceof ProtocolParseError) {
      expect(error.code).toBe("INVALID_CRL_CLAIMS");
    }
  }
}

describe("CRL claims schema", () => {
  it("accepts valid CRL payloads", () => {
    const parsed = parseCrlClaims(makeValidCrlClaims());
    expect(parsed.revocations).toHaveLength(1);
    expect(parsed.revocations[0].agentDid).toMatch(/^did:claw:agent:/);
  });

  it("rejects missing required fields", () => {
    const claims = makeValidCrlClaims();
    delete (claims as Record<string, unknown>).revocations;

    expectInvalidCrl(claims);
  });

  it("rejects empty revocation arrays", () => {
    const claims = makeValidCrlClaims();
    claims.revocations = [];

    expectInvalidCrl(claims);
  });

  it("rejects non-agent DIDs for revocations", () => {
    const claims = makeValidCrlClaims();
    claims.revocations[0].agentDid = makeHumanDid(generateUlid(1700000000000));

    expectInvalidCrl(claims);
  });

  it("rejects invalid ULIDs in revocation entries", () => {
    const claims = makeValidCrlClaims();
    claims.revocations[0].jti = "not-a-ulid";

    expectInvalidCrl(claims);
  });

  it("rejects exp <= iat", () => {
    const claims = makeValidCrlClaims();
    claims.exp = claims.iat;

    expectInvalidCrl(claims);
  });

  it("rejects unknown top-level claims", () => {
    const claims = makeValidCrlClaims() as Record<string, unknown>;
    claims.extra = "unexpected";

    expectInvalidCrl(claims);
  });
});
