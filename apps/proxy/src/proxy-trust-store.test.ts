import { describe, expect, it } from "vitest";
import { createInMemoryProxyTrustStore } from "./proxy-trust-store.js";

describe("in-memory proxy trust store", () => {
  it("allows same-agent sender and recipient without explicit pair entry", async () => {
    const store = createInMemoryProxyTrustStore();
    expect(
      await store.isPairAllowed({
        initiatorAgentDid: "did:claw:agent:alice",
        responderAgentDid: "did:claw:agent:alice",
      }),
    ).toBe(true);
  });

  it("supports symmetric pair checks", async () => {
    const store = createInMemoryProxyTrustStore();
    await store.upsertPair({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
    });

    expect(
      await store.isPairAllowed({
        initiatorAgentDid: "did:claw:agent:alice",
        responderAgentDid: "did:claw:agent:bob",
      }),
    ).toBe(true);
    expect(
      await store.isPairAllowed({
        initiatorAgentDid: "did:claw:agent:bob",
        responderAgentDid: "did:claw:agent:alice",
      }),
    ).toBe(true);
  });

  it("tracks known agents through pair index updates", async () => {
    const store = createInMemoryProxyTrustStore();
    expect(await store.isAgentKnown("did:claw:agent:alice")).toBe(false);
    expect(await store.isAgentKnown("did:claw:agent:bob")).toBe(false);

    await store.upsertPair({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
    });

    expect(await store.isAgentKnown("did:claw:agent:alice")).toBe(true);
    expect(await store.isAgentKnown("did:claw:agent:bob")).toBe(true);
    expect(await store.isAgentKnown("did:claw:agent:charlie")).toBe(false);
  });

  it("consumes one-time pairing codes", async () => {
    const store = createInMemoryProxyTrustStore();
    const code = await store.createPairingCode({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });

    const consumed = await store.consumePairingCode({
      pairingCode: code.pairingCode,
      responderAgentDid: "did:claw:agent:bob",
      nowMs: 1_700_000_000_100,
    });

    expect(consumed).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
    });

    await expect(
      store.consumePairingCode({
        pairingCode: code.pairingCode,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_000_200,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_CODE_NOT_FOUND",
      status: 404,
    });
  });

  it("confirms pairing code atomically and establishes trust", async () => {
    const store = createInMemoryProxyTrustStore();
    const code = await store.createPairingCode({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });

    const confirmed = await store.confirmPairingCode({
      pairingCode: code.pairingCode,
      responderAgentDid: "did:claw:agent:bob",
      nowMs: 1_700_000_000_100,
    });

    expect(confirmed).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
    });
    expect(await store.isAgentKnown("did:claw:agent:alice")).toBe(true);
    expect(await store.isAgentKnown("did:claw:agent:bob")).toBe(true);
    expect(
      await store.isPairAllowed({
        initiatorAgentDid: "did:claw:agent:alice",
        responderAgentDid: "did:claw:agent:bob",
      }),
    ).toBe(true);
    expect(
      await store.isPairAllowed({
        initiatorAgentDid: "did:claw:agent:bob",
        responderAgentDid: "did:claw:agent:alice",
      }),
    ).toBe(true);

    await expect(
      store.consumePairingCode({
        pairingCode: code.pairingCode,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_000_200,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_CODE_NOT_FOUND",
      status: 404,
    });
  });
});
