import { describe, expect, it } from "vitest";
import { parseAitClaims, validateAgentName } from "./ait.js";
import { encodeBase64url } from "./base64url.js";
import { makeAgentDid, makeHumanDid } from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { generateUlid } from "./ulid.js";

function makeValidClaims() {
  const agentUlid = generateUlid(1700000000000);
  const ownerUlid = generateUlid(1700000000100);
  const now = 1700000000;

  return {
    iss: "https://registry.clawdentity.dev",
    sub: makeAgentDid(agentUlid),
    ownerDid: makeHumanDid(ownerUlid),
    name: "agent_name.v1",
    framework: "openclaw",
    description: "Safe agent description.",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
      },
    },
    iat: now,
    nbf: now,
    exp: now + 3600,
    jti: generateUlid(1700000000200),
  };
}

describe("AIT name validation", () => {
  it("accepts valid names", () => {
    expect(validateAgentName("agent-1")).toBe(true);
    expect(validateAgentName("Agent Name")).toBe(true);
    expect(validateAgentName("agent_name.v1")).toBe(true);
    expect(validateAgentName("A")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(validateAgentName("")).toBe(false);
    expect(validateAgentName("a".repeat(65))).toBe(false);
    expect(validateAgentName("agent\nname")).toBe(false);
    expect(validateAgentName("agent\tname")).toBe(false);
    expect(validateAgentName(`agent${String.fromCharCode(0)}name`)).toBe(false);
    expect(validateAgentName("agent🙂")).toBe(false);
    expect(validateAgentName("agent/name")).toBe(false);
  });
});

describe("AIT claims schema", () => {
  it("accepts valid MVP claims", () => {
    const parsed = parseAitClaims(makeValidClaims());
    expect(parsed.sub).toMatch(/^did:claw:agent:/);
    expect(parsed.ownerDid).toMatch(/^did:claw:human:/);
    expect(parsed.cnf.jwk.kty).toBe("OKP");
    expect(parsed.cnf.jwk.crv).toBe("Ed25519");
  });

  it("rejects missing required claims", () => {
    const claims = makeValidClaims();
    delete (claims as Record<string, unknown>).ownerDid;

    expect(() => parseAitClaims(claims)).toThrow(ProtocolParseError);
  });

  it("rejects wrong DID kinds for sub and ownerDid", () => {
    const claimsWithHumanSub = makeValidClaims();
    claimsWithHumanSub.sub = claimsWithHumanSub.ownerDid;

    const claimsWithAgentOwner = makeValidClaims();
    claimsWithAgentOwner.ownerDid = claimsWithAgentOwner.sub;

    expect(() => parseAitClaims(claimsWithHumanSub)).toThrow(
      ProtocolParseError,
    );
    expect(() => parseAitClaims(claimsWithAgentOwner)).toThrow(
      ProtocolParseError,
    );
  });

  it("rejects invalid cnf.jwk fields", () => {
    const badKty = makeValidClaims();
    badKty.cnf.jwk.kty = "EC";

    const badCrv = makeValidClaims();
    badCrv.cnf.jwk.crv = "P-256";

    const badX = makeValidClaims();
    badX.cnf.jwk.x = "invalid+base64url";

    const shortX = makeValidClaims();
    shortX.cnf.jwk.x = encodeBase64url(Uint8Array.from([1]));

    expect(() => parseAitClaims(badKty)).toThrow(ProtocolParseError);
    expect(() => parseAitClaims(badCrv)).toThrow(ProtocolParseError);
    expect(() => parseAitClaims(badX)).toThrow(ProtocolParseError);
    expect(() => parseAitClaims(shortX)).toThrow(ProtocolParseError);
  });

  it("rejects invalid temporal ordering", () => {
    const expBeforeNbf = makeValidClaims();
    expBeforeNbf.exp = expBeforeNbf.nbf;

    const expBeforeIat = makeValidClaims();
    expBeforeIat.exp = expBeforeIat.iat;

    expect(() => parseAitClaims(expBeforeNbf)).toThrow(ProtocolParseError);
    expect(() => parseAitClaims(expBeforeIat)).toThrow(ProtocolParseError);
  });

  it("rejects invalid jti", () => {
    const claims = makeValidClaims();
    claims.jti = "not-a-ulid";
    expect(() => parseAitClaims(claims)).toThrow(ProtocolParseError);
  });

  it("rejects invalid name and description", () => {
    const badName = makeValidClaims();
    badName.name = "bad/name";

    const badDescriptionControl = makeValidClaims();
    badDescriptionControl.description = "line one\nline two";

    const badDescriptionLong = makeValidClaims();
    badDescriptionLong.description = "x".repeat(281);

    expect(() => parseAitClaims(badName)).toThrow(ProtocolParseError);
    expect(() => parseAitClaims(badDescriptionControl)).toThrow(
      ProtocolParseError,
    );
    expect(() => parseAitClaims(badDescriptionLong)).toThrow(
      ProtocolParseError,
    );
  });

  it("accepts omitted description", () => {
    const claims = makeValidClaims();
    delete (claims as Record<string, unknown>).description;

    expect(parseAitClaims(claims).description).toBeUndefined();
  });

  it("rejects unknown top-level claims", () => {
    const claims = {
      ...makeValidClaims(),
      unknownClaim: "should-fail",
    };

    expect(() => parseAitClaims(claims)).toThrow(ProtocolParseError);
  });
});
