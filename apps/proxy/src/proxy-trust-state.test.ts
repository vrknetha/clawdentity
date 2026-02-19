import { decodeBase64url, encodeBase64url } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
} from "./pairing-ticket.js";
import { ProxyTrustState } from "./proxy-trust-state.js";
import { TRUST_STORE_ROUTES } from "./proxy-trust-store.js";

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

function createStorageHarness(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));

  return {
    values,
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      setAlarm: vi.fn(async (_scheduled: number | Date) => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
  };
}

function createProxyTrustState(initialStorage?: Record<string, unknown>) {
  const harness = createStorageHarness(initialStorage);
  const state = {
    storage: harness.storage,
  };

  return {
    proxyTrustState: new ProxyTrustState(
      state as unknown as DurableObjectState,
    ),
    harness,
  };
}

function makeRequest(path: string, body: unknown): Request {
  return new Request(`https://proxy-trust-state${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

describe("ProxyTrustState", () => {
  it("persists and answers known-agent checks via agent peer index", async () => {
    const { proxyTrustState, harness } = createProxyTrustState();

    const upsertResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.upsertPair, {
        initiatorAgentDid: "did:claw:agent:alice",
        responderAgentDid: "did:claw:agent:bob",
      }),
    );

    expect(upsertResponse.status).toBe(200);

    const knownAliceResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentKnown, {
        agentDid: "did:claw:agent:alice",
      }),
    );
    expect(knownAliceResponse.status).toBe(200);
    expect((await knownAliceResponse.json()) as { known: boolean }).toEqual({
      known: true,
    });

    expect(harness.values.has("trust:agent-peers")).toBe(true);
  });

  it("confirms pairing ticket in one operation and persists trust", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid: "did:claw:agent:alice",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: ticketBody.ticket,
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(200);
    expect(
      (await confirmResponse.json()) as {
        initiatorAgentDid: string;
        responderAgentDid: string;
        issuerProxyUrl: string;
      },
    ).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    const pairCheckResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isPairAllowed, {
        initiatorAgentDid: "did:claw:agent:bob",
        responderAgentDid: "did:claw:agent:alice",
      }),
    );
    expect((await pairCheckResponse.json()) as { allowed: boolean }).toEqual({
      allowed: true,
    });

    const statusResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.getPairingTicketStatus, {
        ticket: ticketBody.ticket,
        nowMs: 1_700_000_000_150,
      }),
    );

    expect(statusResponse.status).toBe(200);
    expect(
      (await statusResponse.json()) as {
        status: string;
        initiatorAgentDid: string;
        responderAgentDid: string;
      },
    ).toMatchObject({
      status: "confirmed",
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: "did:claw:agent:bob",
      responderProfile: RESPONDER_PROFILE,
      expiresAtMs: 1_700_000_060_000,
      confirmedAtMs: 1_700_000_000_000,
    });
  });

  it("returns pending status before a ticket is confirmed", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid: "did:claw:agent:alice",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const statusResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.getPairingTicketStatus, {
        ticket: ticketBody.ticket,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(statusResponse.status).toBe(200);
    expect(
      (await statusResponse.json()) as {
        status: string;
      },
    ).toMatchObject({
      status: "pending",
      initiatorAgentDid: "did:claw:agent:alice",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      expiresAtMs: 1_700_000_060_000,
    });
  });

  it("normalizes pairing ticket expiry to whole seconds", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_123,
      expiresAtMs: 1_700_000_060_123,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid: "did:claw:agent:alice",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        expiresAtMs: 1_700_000_060_123,
        nowMs: 1_700_000_000_123,
      }),
    );

    expect(ticketResponse.status).toBe(200);
    expect(
      (await ticketResponse.json()) as {
        expiresAtMs: number;
      },
    ).toMatchObject({
      expiresAtMs: 1_700_000_060_000,
    });
  });

  it("rejects tampered ticket text when kid matches stored entry", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid: "did:claw:agent:alice",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: tamperTicketNonce(ticketBody.ticket),
        responderAgentDid: "did:claw:agent:bob",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(404);
    expect(
      (await confirmResponse.json()) as { error: { code: string } },
    ).toEqual({
      error: {
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
      },
    });
  });
});
