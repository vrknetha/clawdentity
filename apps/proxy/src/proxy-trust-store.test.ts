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

  it("confirms one-time pairing tickets and establishes trust", async () => {
    const store = createInMemoryProxyTrustStore();
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      issuerProxyUrl: "https://proxy-a.example.com",
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });

    const confirmed = await store.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid: "did:claw:agent:bob",
      nowMs: 1_700_000_000_100,
    });

    expect(confirmed).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_000_200,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });

    expect(await store.isAgentKnown("did:claw:agent:alice")).toBe(true);
    expect(await store.isAgentKnown("did:claw:agent:bob")).toBe(true);
  });

  it("rejects expired tickets", async () => {
    const store = createInMemoryProxyTrustStore();
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      issuerProxyUrl: "https://proxy-a.example.com",
      ttlSeconds: 1,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_002_000,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_EXPIRED",
      status: 410,
    });
  });

  it("cleans up unrelated expired tickets during confirm lookups", async () => {
    const store = createInMemoryProxyTrustStore();

    const expiredTicket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      issuerProxyUrl: "https://proxy-a.example.com",
      ttlSeconds: 1,
      nowMs: 1_700_000_000_000,
    });

    const validTicket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      issuerProxyUrl: "https://proxy-a.example.com",
      ttlSeconds: 60,
      nowMs: 1_700_000_000_000,
    });

    await store.confirmPairingTicket({
      ticket: validTicket.ticket,
      responderAgentDid: "did:claw:agent:bob",
      nowMs: 1_700_000_002_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: expiredTicket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_002_100,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });
  });
});
