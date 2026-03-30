import { describe, expect, it } from "vitest";
import {
  makeAgentDid,
  makeHumanDid,
  parseAgentDid,
  parseDid,
  parseGroupId,
  parseHumanDid,
} from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { generateUlid } from "./ulid.js";

const AUTHORITY = "registry.clawdentity.dev";

function expectInvalidDid(action: () => unknown): void {
  try {
    action();
    throw new Error("expected DID operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolParseError);
    if (error instanceof ProtocolParseError) {
      expect(error.code).toBe("INVALID_DID");
    }
  }
}

describe("did helpers", () => {
  it("builds and parses human DIDs", () => {
    const ulid = generateUlid(1700000000000);
    const did = makeHumanDid(AUTHORITY, ulid);
    expect(did).toBe(`did:cdi:${AUTHORITY}:human:${ulid}`);
    expect(parseDid(did)).toEqual({
      method: "cdi",
      authority: AUTHORITY,
      entity: "human",
      ulid,
    });
    expect(parseHumanDid(did)).toEqual({
      method: "cdi",
      authority: AUTHORITY,
      entity: "human",
      ulid,
    });
  });

  it("builds and parses agent DIDs", () => {
    const ulid = generateUlid(1700000000000);
    const did = makeAgentDid(AUTHORITY, ulid);
    expect(did).toBe(`did:cdi:${AUTHORITY}:agent:${ulid}`);
    expect(parseDid(did)).toEqual({
      method: "cdi",
      authority: AUTHORITY,
      entity: "agent",
      ulid,
    });
    expect(parseAgentDid(did)).toEqual({
      method: "cdi",
      authority: AUTHORITY,
      entity: "agent",
      ulid,
    });
  });

  it("rejects malformed DIDs", () => {
    const samples = [
      "did:foo:registry.clawdentity.dev:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:other:registry.clawdentity.dev:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:cdi:registry.clawdentity.dev:bot:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:cdi:registry.clawdentity.dev:human",
      "did:cdi:registry.clawdentity.dev:human:invalid-ulid",
      "did:cdi:registry..clawdentity.dev:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:cdi:-registry.clawdentity.dev:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:cdi:Registry.clawdentity.dev:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
      "did:cdi:localhost:agent:01HF7YAT00M5H6RVQ6Q6N1W30X",
    ];

    for (const sample of samples) {
      expectInvalidDid(() => {
        parseDid(sample);
      });
    }
  });

  it("rejects invalid entity-specific parse helpers", () => {
    const ulid = generateUlid(1700000000000);
    const humanDid = makeHumanDid(AUTHORITY, ulid);
    const agentDid = makeAgentDid(AUTHORITY, ulid);

    expectInvalidDid(() => parseAgentDid(humanDid));
    expectInvalidDid(() => parseHumanDid(agentDid));
  });

  it("rejects invalid authority and ULID input in make helpers", () => {
    expectInvalidDid(() =>
      makeHumanDid("registry..clawdentity.dev", generateUlid(1)),
    );
    expectInvalidDid(() => makeHumanDid(AUTHORITY, "invalid-ulid"));
  });

  it("parses group IDs", () => {
    const groupId = `grp_${generateUlid(1700000000000)}`;
    expect(parseGroupId(groupId)).toBe(groupId);
  });

  it("rejects malformed group IDs", () => {
    const invalidSamples = [
      "",
      "grp_",
      "grp_not-a-ulid",
      "group_01HF7YAT31JZHSMW1CG6Q6MHB7",
      "01HF7YAT31JZHSMW1CG6Q6MHB7",
    ];

    for (const sample of invalidSamples) {
      expect(() => parseGroupId(sample)).toThrow(ProtocolParseError);
    }
  });
});
