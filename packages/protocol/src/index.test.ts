import { describe, expect, it } from "vitest";
import {
  ADMIN_BOOTSTRAP_PATH,
  ADMIN_INTERNAL_SERVICES_PATH,
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_VALIDATE_PATH,
  AGENT_NAME_REGEX,
  AGENT_REGISTRATION_CHALLENGE_PATH,
  AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE,
  AGENT_REGISTRATION_PROOF_VERSION,
  aitClaimsSchema,
  CLAW_PROOF_CANONICAL_VERSION,
  canonicalizeAgentRegistrationProof,
  canonicalizeRequest,
  crlClaimsSchema,
  decodeBase64url,
  encodeBase64url,
  generateUlid,
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  ME_API_KEYS_PATH,
  makeAgentDid,
  makeHumanDid,
  PROTOCOL_VERSION,
  ProtocolParseError,
  parseAitClaims,
  parseCrlClaims,
  parseDid,
  parseUlid,
  REGISTRY_METADATA_PATH,
  RELAY_CONNECT_PATH,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
  validateAgentName,
} from "./index.js";

describe("protocol", () => {
  it("exports PROTOCOL_VERSION", () => {
    expect(PROTOCOL_VERSION).toBe("0.0.0");
  });

  it("exports shared endpoint constants", () => {
    expect(ADMIN_BOOTSTRAP_PATH).toBe("/v1/admin/bootstrap");
    expect(ADMIN_INTERNAL_SERVICES_PATH).toBe("/v1/admin/internal-services");
    expect(AGENT_REGISTRATION_CHALLENGE_PATH).toBe("/v1/agents/challenge");
    expect(AGENT_AUTH_REFRESH_PATH).toBe("/v1/agents/auth/refresh");
    expect(AGENT_AUTH_VALIDATE_PATH).toBe("/v1/agents/auth/validate");
    expect(INVITES_PATH).toBe("/v1/invites");
    expect(INVITES_REDEEM_PATH).toBe("/v1/invites/redeem");
    expect(ME_API_KEYS_PATH).toBe("/v1/me/api-keys");
    expect(REGISTRY_METADATA_PATH).toBe("/v1/metadata");
    expect(INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH).toBe(
      "/internal/v1/identity/agent-ownership",
    );
    expect(RELAY_CONNECT_PATH).toBe("/v1/relay/connect");
    expect(RELAY_RECIPIENT_AGENT_DID_HEADER).toBe("x-claw-recipient-agent-did");
  });

  it("exports helpers from package root", () => {
    const ulid = generateUlid(1700000000000);
    const humanDid = makeHumanDid(ulid);
    const agentDid = makeAgentDid(ulid);
    const encoded = encodeBase64url(Uint8Array.from([1, 2, 3]));

    expect(encoded).toBe("AQID");
    expect(Array.from(decodeBase64url(encoded))).toEqual([1, 2, 3]);
    expect(parseUlid(ulid).value).toBe(ulid);
    expect(parseDid(humanDid)).toEqual({ kind: "human", ulid });
    expect(parseDid(agentDid)).toEqual({ kind: "agent", ulid });
    expect(ProtocolParseError).toBeTypeOf("function");
  });

  it("exports http signing canonicalization helpers", () => {
    const canonical = canonicalizeRequest({
      method: "post",
      pathWithQuery: "/v1/messages?b=2&a=1",
      timestamp: "1739364000",
      nonce: "nonce_abc123",
      bodyHash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    });

    expect(CLAW_PROOF_CANONICAL_VERSION).toBe("CLAW-PROOF-V1");
    expect(canonical).toBe(
      [
        "CLAW-PROOF-V1",
        "POST",
        "/v1/messages?b=2&a=1",
        "1739364000",
        "nonce_abc123",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
      ].join("\n"),
    );
  });

  it("exports agent registration proof canonicalization helpers", () => {
    const canonical = canonicalizeAgentRegistrationProof({
      challengeId: "01JCHALLENGEABC",
      nonce: "nonce123",
      ownerDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
      publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
      name: "agent_01",
    });

    expect(AGENT_REGISTRATION_PROOF_VERSION).toBe("clawdentity.register.v1");
    expect(AGENT_REGISTRATION_PROOF_MESSAGE_TEMPLATE).toBe(
      [
        "clawdentity.register.v1",
        "challengeId:{challengeId}",
        "nonce:{nonce}",
        "ownerDid:{ownerDid}",
        "publicKey:{publicKey}",
        "name:{name}",
        "framework:{framework}",
        "ttlDays:{ttlDays}",
      ].join("\n"),
    );
    expect(canonical).toBe(
      [
        "clawdentity.register.v1",
        "challengeId:01JCHALLENGEABC",
        "nonce:nonce123",
        "ownerDid:did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        "publicKey:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        "name:agent_01",
        "framework:",
        "ttlDays:",
      ].join("\n"),
    );
  });

  it("exports AIT helpers from package root", () => {
    const agentUlid = generateUlid(1700000000000);
    const ownerUlid = generateUlid(1700000000100);
    const parsed = parseAitClaims({
      iss: "https://registry.clawdentity.dev",
      sub: makeAgentDid(agentUlid),
      ownerDid: makeHumanDid(ownerUlid),
      name: "agent_01",
      framework: "openclaw",
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
        },
      },
      iat: 1700000000,
      nbf: 1700000000,
      exp: 1700003600,
      jti: generateUlid(1700000000200),
    });

    expect(validateAgentName("agent_01")).toBe(true);
    expect(validateAgentName("bad/name")).toBe(false);
    expect(parsed.name).toBe("agent_01");
    expect(MAX_AGENT_NAME_LENGTH).toBe(64);
    expect(MAX_AGENT_DESCRIPTION_LENGTH).toBe(280);
    expect(AGENT_NAME_REGEX.test("agent_01")).toBe(true);
    expect(aitClaimsSchema).toBeDefined();
  });

  it("exports CRL helpers from package root", () => {
    const now = 1700000000;
    const agentUlid = generateUlid(now);
    const agentDid = makeAgentDid(agentUlid);

    const parsed = parseCrlClaims({
      iss: "https://registry.clawdentity.dev",
      jti: generateUlid(now + 1000),
      iat: now,
      exp: now + 3600,
      revocations: [
        {
          jti: generateUlid(now + 2000),
          agentDid,
          reason: "manual revoke",
          revokedAt: now + 100,
        },
      ],
    });

    expect(parsed.revocations[0].agentDid).toBe(agentDid);
    expect(crlClaimsSchema).toBeDefined();
  });
});
