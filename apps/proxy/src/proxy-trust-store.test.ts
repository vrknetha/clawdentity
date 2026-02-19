import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
} from "./pairing-ticket.js";
import { createInMemoryProxyTrustStore } from "./proxy-trust-store.js";

const INITIATOR_PROFILE = {
  agentName: "alpha",
  humanName: "Ravi",
};

const RESPONDER_PROFILE = {
  agentName: "beta",
  humanName: "Ira",
};

function tamperTicketNonce(ticket: string): string {
  const prefix = "clwpair1_";
  if (!ticket.startsWith(prefix)) {
    throw new Error("invalid test ticket format");
  }
  const encodedPayload = ticket.slice(prefix.length);

  const payload = JSON.parse(
    new TextDecoder().decode(decodeBase64url(encodedPayload)),
  ) as {
    nonce?: string;
  };
  payload.nonce = "tampered-nonce";

  return `${prefix}${encodeBase64url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

async function createSignedTicket(input: {
  issuerProxyUrl: string;
  nowMs: number;
  expiresAtMs: number;
}) {
  const signingKey = await createPairingTicketSigningKey({
    nowMs: input.nowMs,
  });

  return createPairingTicket({
    issuerProxyUrl: input.issuerProxyUrl,
    expiresAtMs: input.expiresAtMs,
    nowMs: input.nowMs,
    signingKey: {
      pkid: signingKey.pkid,
      privateKey: signingKey.privateKey,
    },
  });
}

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
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    const confirmed = await store.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_000_100,
    });

    expect(confirmed).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_200,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });

    expect(await store.isAgentKnown("did:claw:agent:alice")).toBe(true);
    expect(await store.isAgentKnown("did:claw:agent:bob")).toBe(true);
  });

  it("returns pending and confirmed pairing ticket status for initiator polling", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.getPairingTicketStatus({
        ticket: ticket.ticket,
        nowMs: 1_700_000_000_100,
      }),
    ).resolves.toEqual({
      status: "pending",
      ticket: ticket.ticket,
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      expiresAtMs: 1_700_000_060_000,
    });

    await store.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_000_300,
    });

    await expect(
      store.getPairingTicketStatus({
        ticket: ticket.ticket,
        nowMs: 1_700_000_000_400,
      }),
    ).resolves.toEqual({
      status: "confirmed",
      ticket: ticket.ticket,
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      expiresAtMs: 1_700_000_060_000,
      confirmedAtMs: 1_700_000_000_000,
    });
  });

  it("normalizes pairing ticket expiry to whole seconds", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_123,
      expiresAtMs: 1_700_000_060_123,
    });

    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      expiresAtMs: 1_700_000_060_123,
      nowMs: 1_700_000_000_123,
    });

    expect(ticket.expiresAtMs).toBe(1_700_000_060_000);
  });

  it("rejects tampered ticket text when kid matches stored entry", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: tamperTicketNonce(ticket.ticket),
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });
  });

  it("rejects expired tickets", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_001_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      expiresAtMs: 1_700_000_001_000,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_002_000,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_EXPIRED",
      status: 410,
    });

    await expect(
      store.getPairingTicketStatus({
        ticket: ticket.ticket,
        nowMs: 1_700_000_002_000,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_EXPIRED",
      status: 410,
    });
  });

  it("cleans up unrelated expired tickets during confirm lookups", async () => {
    const store = createInMemoryProxyTrustStore();

    const expired = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_001_000,
    });
    const expiredTicket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: expired.ticket,
      expiresAtMs: 1_700_000_001_000,
      nowMs: 1_700_000_000_000,
    });

    const valid = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const validTicket = await store.createPairingTicket({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: valid.ticket,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    await store.confirmPairingTicket({
      ticket: validTicket.ticket,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_002_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: expiredTicket.ticket,
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_002_100,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });
  });
});
