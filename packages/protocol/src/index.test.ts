import { describe, expect, it } from "vitest";
import {
  ADMIN_BOOTSTRAP_PATH,
  ADMIN_INTERNAL_SERVICES_PATH,
  AGENT_AUTH_ISSUED_EVENT_TYPE,
  AGENT_AUTH_REFRESH_PATH,
  AGENT_AUTH_REFRESH_REJECTED_EVENT_TYPE,
  AGENT_AUTH_REFRESHED_EVENT_TYPE,
  AGENT_AUTH_REVOKED_EVENT_TYPE,
  AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY,
  AGENT_AUTH_REVOKED_REASON_AGENT_REVOKED,
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
  GITHUB_ONBOARDING_CALLBACK_PATH,
  GITHUB_ONBOARDING_START_PATH,
  GROUP_JOIN_PATH,
  GROUP_MEMBER_JOINED_EVENT_TYPE,
  GROUP_MEMBER_JOINED_NOTIFICATION_MESSAGE,
  GROUP_MEMBER_JOINED_TRUSTED_DELIVERY_SOURCE,
  GROUP_MEMBERSHIP_CHECK_PATH,
  GROUPS_PATH,
  generateUlid,
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  ME_API_KEYS_PATH,
  makeAgentDid,
  makeHumanDid,
  PAIR_ACCEPTED_EVENT_TYPE,
  PAIR_ACCEPTED_NOTIFICATION_MESSAGE,
  PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE,
  PROTOCOL_VERSION,
  ProtocolParseError,
  parseAgentAuthRevokedMetadata,
  parseAgentDid,
  parseAitClaims,
  parseCrlClaims,
  parseDid,
  parseGroupId,
  parseGroupMemberJoinedEventData,
  parseHumanDid,
  parsePairAcceptedEvent,
  parseUlid,
  REGISTRY_METADATA_PATH,
  RELAY_CONNECT_PATH,
  RELAY_GROUP_ID_HEADER,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
  STARTER_PASSES_REDEEM_PATH,
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
    expect(STARTER_PASSES_REDEEM_PATH).toBe("/v1/starter-passes/redeem");
    expect(GITHUB_ONBOARDING_START_PATH).toBe("/v1/onboarding/github/start");
    expect(GITHUB_ONBOARDING_CALLBACK_PATH).toBe(
      "/v1/onboarding/github/callback",
    );
    expect(ME_API_KEYS_PATH).toBe("/v1/me/api-keys");
    expect(GROUPS_PATH).toBe("/v1/groups");
    expect(GROUP_JOIN_PATH).toBe("/v1/groups/join");
    expect(GROUP_MEMBERSHIP_CHECK_PATH).toBe(
      "/internal/v1/groups/membership/check",
    );
    expect(REGISTRY_METADATA_PATH).toBe("/v1/metadata");
    expect(INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH).toBe(
      "/internal/v1/identity/agent-ownership",
    );
    expect(RELAY_CONNECT_PATH).toBe("/v1/relay/connect");
    expect(RELAY_RECIPIENT_AGENT_DID_HEADER).toBe("x-claw-recipient-agent-did");
    expect(RELAY_GROUP_ID_HEADER).toBe("x-claw-group-id");
  });

  it("exports shared agent-auth revocation constants and parser", () => {
    expect(AGENT_AUTH_ISSUED_EVENT_TYPE).toBe("agent.auth.issued");
    expect(AGENT_AUTH_REFRESHED_EVENT_TYPE).toBe("agent.auth.refreshed");
    expect(AGENT_AUTH_REVOKED_EVENT_TYPE).toBe("agent.auth.revoked");
    expect(AGENT_AUTH_REFRESH_REJECTED_EVENT_TYPE).toBe(
      "agent.auth.refresh_rejected",
    );
    expect(AGENT_AUTH_REVOKED_REASON_AGENT_REVOKED).toBe("agent_revoked");
    expect(AGENT_AUTH_REVOKED_METADATA_AGENT_DID_KEY).toBe("agentDid");
    expect(
      parseAgentAuthRevokedMetadata({
        agentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      }),
    ).toEqual({
      agentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
    });
  });

  it("exports pair accepted queue event constants and parser", () => {
    expect(PAIR_ACCEPTED_EVENT_TYPE).toBe("pair.accepted");
    expect(PAIR_ACCEPTED_NOTIFICATION_MESSAGE).toBe(
      "Clawdentity pairing complete. You can now message this peer.",
    );
    expect(PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE).toBe(
      "proxy.events.queue.pair_accepted",
    );
    expect(
      parsePairAcceptedEvent({
        type: "pair.accepted",
        initiatorAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        responderAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderProfile: {
          agentName: "beta",
          humanName: "Ira",
          proxyOrigin: "https://beta.proxy.example",
        },
        issuerProxyOrigin: "https://proxy.clawdentity.dev",
        eventTimestampUtc: "2026-03-28T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "pair.accepted",
      initiatorAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      responderAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
    });
  });

  it("exports group member joined queue event constants and parser", () => {
    expect(GROUP_MEMBER_JOINED_EVENT_TYPE).toBe("group.member.joined");
    expect(GROUP_MEMBER_JOINED_NOTIFICATION_MESSAGE).toBe(
      "A member joined your group.",
    );
    expect(GROUP_MEMBER_JOINED_TRUSTED_DELIVERY_SOURCE).toBe(
      "proxy.events.queue.group_member_joined",
    );
    expect(
      parseGroupMemberJoinedEventData({
        recipientAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        joinedAgentDid:
          "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        joinedAgentName: "beta",
        groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
        groupName: "alpha squad",
        role: "member",
        joinedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toMatchObject({
      recipientAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      joinedAgentDid:
        "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
      groupId: "grp_01HF7YAT31JZHSMW1CG6Q6MHB7",
    });
  });

  it("exports helpers from package root", () => {
    const authority = "registry.clawdentity.dev";
    const ulid = generateUlid(1700000000000);
    const humanDid = makeHumanDid(authority, ulid);
    const agentDid = makeAgentDid(authority, ulid);
    const encoded = encodeBase64url(Uint8Array.from([1, 2, 3]));

    expect(encoded).toBe("AQID");
    expect(Array.from(decodeBase64url(encoded))).toEqual([1, 2, 3]);
    expect(parseUlid(ulid).value).toBe(ulid);
    expect(parseDid(humanDid)).toEqual({
      method: "cdi",
      authority,
      entity: "human",
      ulid,
    });
    expect(parseDid(agentDid)).toEqual({
      method: "cdi",
      authority,
      entity: "agent",
      ulid,
    });
    expect(parseHumanDid(humanDid).entity).toBe("human");
    expect(parseAgentDid(agentDid).entity).toBe("agent");
    expect(parseGroupId(`grp_${ulid}`)).toBe(`grp_${ulid}`);
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
      ownerDid:
        "did:cdi:registry.clawdentity.dev:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
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
        "ownerDid:did:cdi:registry.clawdentity.dev:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        "publicKey:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        "name:agent_01",
        "framework:",
        "ttlDays:",
      ].join("\n"),
    );
  });

  it("exports AIT helpers from package root", () => {
    const authority = "registry.clawdentity.dev";
    const agentUlid = generateUlid(1700000000000);
    const ownerUlid = generateUlid(1700000000100);
    const parsed = parseAitClaims({
      iss: `https://${authority}`,
      sub: makeAgentDid(authority, agentUlid),
      ownerDid: makeHumanDid(authority, ownerUlid),
      name: "agent_01",
      framework: "generic",
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
    const authority = "registry.clawdentity.dev";
    const now = 1700000000;
    const agentUlid = generateUlid(now);
    const agentDid = makeAgentDid(authority, agentUlid);

    const parsed = parseCrlClaims({
      iss: `https://${authority}`,
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
