import { parseDid, parseUlid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { buildTestAitClaims } from "./ait-fixtures.js";

describe("buildTestAitClaims", () => {
  it("builds deterministic claims from a fixed seed", () => {
    const claims = buildTestAitClaims({
      publicKeyX: "test-public-key-x",
      seedMs: 1_700_000_000_000,
      nowSeconds: 1_700_000_000,
    });

    expect(claims.iss).toBe("https://registry.clawdentity.com");
    expect(parseDid(claims.sub).method).toBe("cdi");
    expect(parseDid(claims.sub).authority).toBe("registry.clawdentity.com");
    expect(parseDid(claims.sub).entity).toBe("agent");
    expect(parseDid(claims.ownerDid).entity).toBe("human");
    expect(parseDid(claims.ownerDid).authority).toBe(
      "registry.clawdentity.com",
    );
    expect(parseUlid(parseDid(claims.sub).ulid).timestampMs).toBe(
      1_700_000_000_010,
    );
    expect(parseUlid(parseDid(claims.ownerDid).ulid).timestampMs).toBe(
      1_700_000_000_020,
    );
    expect(parseUlid(claims.jti).timestampMs).toBe(1_700_000_000_030);
    expect(claims.exp).toBe(1_700_000_600);
  });

  it("allows caller override fields", () => {
    const claims = buildTestAitClaims({
      publicKeyX: "test-public-key-x",
      issuer: "https://registry.clawdentity.dev",
      name: "registry-agent",
      framework: "custom",
      description: "fixture",
      ttlSeconds: 60,
      nowSeconds: 1_700_000_000,
      seedMs: 1_700_100_000_000,
    });

    expect(claims.iss).toBe("https://registry.clawdentity.dev");
    expect(claims.name).toBe("registry-agent");
    expect(claims.framework).toBe("custom");
    expect(claims.description).toBe("fixture");
    expect(claims.exp).toBe(1_700_000_060);
  });
});
