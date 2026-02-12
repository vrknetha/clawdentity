import { describe, expect, it } from "vitest";
import {
  CLAW_PROOF_CANONICAL_VERSION,
  canonicalizeRequest,
} from "./http-signing.js";

describe("http signing canonicalization", () => {
  it("uses the expected canonical version prefix", () => {
    expect(CLAW_PROOF_CANONICAL_VERSION).toBe("CLAW-PROOF-V1");
  });

  it("matches a representative canonical output snapshot", () => {
    const canonical = canonicalizeRequest({
      method: "post",
      pathWithQuery: "/v1/messages?b=2&a=1",
      timestamp: "1739364000",
      nonce: "nonce_abc123",
      bodyHash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    });

    expect(canonical).toMatchInlineSnapshot(`
      "CLAW-PROOF-V1
      POST
      /v1/messages?b=2&a=1
      1739364000
      nonce_abc123
      47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
    `);
  });

  it("returns identical output for identical input across runs", () => {
    const input = {
      method: "patch",
      pathWithQuery: "/v1/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV?view=full",
      timestamp: "1739364123",
      nonce: "nonce_repeatable",
      bodyHash: "xvYb4zVfQ0jM2fN4Yg0J-9g8F0M9Qz2jQ8J6w0kM1oA",
    };

    const first = canonicalizeRequest(input);
    const second = canonicalizeRequest(input);
    const third = canonicalizeRequest(input);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("uppercases HTTP method in canonical output", () => {
    const canonical = canonicalizeRequest({
      method: "pAtCh",
      pathWithQuery: "/v1/ping",
      timestamp: "1739364300",
      nonce: "nonce_method",
      bodyHash: "hash_method",
    });

    expect(canonical).toContain("\nPATCH\n");
  });

  it("preserves query ordering exactly as provided", () => {
    const canonical = canonicalizeRequest({
      method: "GET",
      pathWithQuery: "/v1/search?z=9&b=2&a=1",
      timestamp: "1739364400",
      nonce: "nonce_query",
      bodyHash: "hash_query",
    });

    expect(canonical).toContain("\n/v1/search?z=9&b=2&a=1\n");
    expect(canonical).not.toContain("\n/v1/search?a=1&b=2&z=9\n");
  });

  it("keeps precomputed empty-body hash unchanged in canonical output", () => {
    const canonical = canonicalizeRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      timestamp: "1739364500",
      nonce: "nonce_empty_body",
      bodyHash: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    });

    expect(canonical).toMatchInlineSnapshot(`
      "CLAW-PROOF-V1
      GET
      /v1/health
      1739364500
      nonce_empty_body
      47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
    `);
  });
});
