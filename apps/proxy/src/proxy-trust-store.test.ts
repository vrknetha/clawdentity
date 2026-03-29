import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
} from "./pairing-ticket.js";
import {
  createInMemoryProxyTrustStore,
  REVOKED_AGENT_MARKER_TTL_MS,
} from "./proxy-trust-store.js";

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

  const created = await createPairingTicket({
    issuerProxyUrl: input.issuerProxyUrl,
    expiresAtMs: input.expiresAtMs,
    nowMs: input.nowMs,
    signingKey: {
      pkid: signingKey.pkid,
      privateKey: signingKey.privateKey,
    },
  });
  return {
    ticket: created.ticket,
    publicKeyX: signingKey.publicKeyX,
  };
}

describe("in-memory proxy trust store", () => {
  it("allows same-agent sender and recipient without explicit pair entry", async () => {
    const store = createInMemoryProxyTrustStore();
    expect(
      await store.isPairAllowed({
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      }),
    ).toBe(true);
  });

  it("supports symmetric pair checks", async () => {
    const store = createInMemoryProxyTrustStore();
    await store.upsertPair({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
    });

    expect(
      await store.isPairAllowed({
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      }),
    ).toBe(true);
    expect(
      await store.isPairAllowed({
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      }),
    ).toBe(true);
  });

  it("tracks known agents through pair index updates", async () => {
    const store = createInMemoryProxyTrustStore();
    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      ),
    ).toBe(false);
    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      ),
    ).toBe(false);

    await store.upsertPair({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
    });

    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      ),
    ).toBe(true);
    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      ),
    ).toBe(true);
    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT4TXP6AW5QNXA2Y9K43",
      ),
    ).toBe(false);
  });

  it("marks and checks revoked agents", async () => {
    const store = createInMemoryProxyTrustStore();
    const revokedAgentDid =
      "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97";

    expect(await store.isAgentRevoked(revokedAgentDid)).toBe(false);
    await store.markAgentRevoked(revokedAgentDid);
    expect(await store.isAgentRevoked(revokedAgentDid)).toBe(true);
  });

  it("expires revoked-agent overlays after TTL", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const store = createInMemoryProxyTrustStore();
      const revokedAgentDid =
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97";

      await store.markAgentRevoked(revokedAgentDid);
      expect(await store.isAgentRevoked(revokedAgentDid)).toBe(true);

      vi.setSystemTime(now.getTime() + REVOKED_AGENT_MARKER_TTL_MS + 1);
      expect(await store.isAgentRevoked(revokedAgentDid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms one-time pairing tickets and establishes trust", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      publicKeyX: created.publicKeyX,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    const confirmed = await store.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_000_100,
    });

    expect(confirmed).toEqual({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_200,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_ALREADY_CONFIRMED",
      status: 409,
    });

    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      ),
    ).toBe(true);
    expect(
      await store.isAgentKnown(
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      ),
    ).toBe(true);
  });

  it("returns pending and confirmed pairing ticket status for initiator polling", async () => {
    const store = createInMemoryProxyTrustStore();
    const created = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const ticket = await store.createPairingTicket({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      publicKeyX: created.publicKeyX,
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      expiresAtMs: 1_700_000_060_000,
    });

    await store.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      publicKeyX: created.publicKeyX,
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      publicKeyX: created.publicKeyX,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: tamperTicketNonce(ticket.ticket),
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_INVALID_SIGNATURE",
      status: 400,
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: created.ticket,
      publicKeyX: created.publicKeyX,
      expiresAtMs: 1_700_000_001_000,
      nowMs: 1_700_000_000_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: ticket.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: expired.ticket,
      publicKeyX: expired.publicKeyX,
      expiresAtMs: 1_700_000_001_000,
      nowMs: 1_700_000_000_000,
    });

    const valid = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const validTicket = await store.createPairingTicket({
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      ticket: valid.ticket,
      publicKeyX: valid.publicKeyX,
      expiresAtMs: 1_700_000_060_000,
      nowMs: 1_700_000_000_000,
    });

    await store.confirmPairingTicket({
      ticket: validTicket.ticket,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_002_000,
    });

    await expect(
      store.confirmPairingTicket({
        ticket: expiredTicket.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_002_100,
      }),
    ).rejects.toMatchObject({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      status: 404,
    });
  });
});
