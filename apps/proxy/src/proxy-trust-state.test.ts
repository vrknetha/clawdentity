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
const RESPONDER_PROFILE_WITH_PROXY_ORIGIN = {
  ...RESPONDER_PROFILE,
  proxyOrigin: "https://beta.proxy.example",
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

describe("ProxyTrustState", () => {
  it("persists revoked-agent markers and serves revoked checks", async () => {
    const { proxyTrustState, harness } = createProxyTrustState();
    const agentDid =
      "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97";

    const beforeResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentRevoked, {
        agentDid,
      }),
    );
    expect(beforeResponse.status).toBe(200);
    expect((await beforeResponse.json()) as { revoked: boolean }).toEqual({
      revoked: false,
    });

    const markResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.markAgentRevoked, {
        agentDid,
      }),
    );
    expect(markResponse.status).toBe(200);
    expect((await markResponse.json()) as { ok: boolean }).toEqual({
      ok: true,
    });

    const afterResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentRevoked, {
        agentDid,
      }),
    );
    expect(afterResponse.status).toBe(200);
    expect((await afterResponse.json()) as { revoked: boolean }).toEqual({
      revoked: true,
    });

    expect(harness.values.has("trust:revoked-agents")).toBe(true);
  });

  it("expires revoked-agent markers after TTL and prunes them on lookup", async () => {
    const { proxyTrustState, harness } = createProxyTrustState();
    const agentDid =
      "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97";

    const markResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.markAgentRevoked, {
        agentDid,
        nowMs: 10_000,
        ttlMs: 1_000,
      }),
    );
    expect(markResponse.status).toBe(200);

    const activeResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentRevoked, {
        agentDid,
        nowMs: 10_500,
      }),
    );
    expect(activeResponse.status).toBe(200);
    expect((await activeResponse.json()) as { revoked: boolean }).toEqual({
      revoked: true,
    });

    const expiredResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentRevoked, {
        agentDid,
        nowMs: 11_000,
      }),
    );
    expect(expiredResponse.status).toBe(200);
    expect((await expiredResponse.json()) as { revoked: boolean }).toEqual({
      revoked: false,
    });
    expect(harness.values.get("trust:revoked-agents")).toEqual({});
  });

  it("persists and answers known-agent checks via agent peer index", async () => {
    const { proxyTrustState, harness } = createProxyTrustState();

    const upsertResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.upsertPair, {
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      }),
    );

    expect(upsertResponse.status).toBe(200);

    const knownAliceResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentKnown, {
        agentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
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
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: ticketBody.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    const pairCheckResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isPairAllowed, {
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
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
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
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
      initiatorAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "https://proxy-a.example.com",
      expiresAtMs: 1_700_000_060_000,
    });
  });

  it("rejects callbackUrl field on ticket creation", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
        callbackUrl: "https://callbacks.example.com/pairing/complete",
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );

    expect(ticketResponse.status).toBe(400);
    expect(
      (await ticketResponse.json()) as { error: { code: string } },
    ).toEqual({
      error: {
        code: "PROXY_PAIR_START_INVALID_BODY",
        message: "callbackUrl is no longer supported",
      },
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
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
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
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: tamperTicketNonce(ticketBody.ticket),
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(400);
    expect(
      (await confirmResponse.json()) as { error: { code: string } },
    ).toEqual({
      error: {
        code: "PROXY_PAIR_TICKET_INVALID_SIGNATURE",
        message: "Pairing ticket signature is invalid",
      },
    });
  });

  it("rejects stored pairing ticket entries missing publicKeyX", async () => {
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const { proxyTrustState } = createProxyTrustState({
      "trust:pairing-tickets": {
        [createdTicket.ticket]: {
          ticket: createdTicket.ticket,
          expiresAtMs: 1_700_000_060_000,
          initiatorAgentDid:
            "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
          initiatorProfile: INITIATOR_PROFILE,
          issuerProxyUrl: "https://proxy-a.example.com",
        },
      },
    });

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: createdTicket.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(404);
    expect(
      (await confirmResponse.json()) as {
        error: {
          code: string;
          message: string;
        };
      },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
      },
    });
  });

  it("rejects replayed pairing ticket confirms with 409", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };
    const confirmBody = {
      ticket: ticketBody.ticket,
      responderAgentDid:
        "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT343FD48SE5Z15FNC01",
      responderProfile: RESPONDER_PROFILE,
      nowMs: 1_700_000_000_100,
    };

    const firstConfirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, confirmBody),
    );
    expect(firstConfirmResponse.status).toBe(200);

    const replayConfirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, confirmBody),
    );
    expect(replayConfirmResponse.status).toBe(409);
    expect(
      (await replayConfirmResponse.json()) as { error: { code: string } },
    ).toEqual({
      error: {
        code: "PROXY_PAIR_TICKET_ALREADY_CONFIRMED",
        message: "Pairing ticket has already been confirmed",
      },
    });
  });

  it("rejects non-allowed responders with 403", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const createdTicket = await createSignedTicket({
      issuerProxyUrl: "https://proxy-a.example.com",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_060_000,
    });
    const allowedResponderAgentDid =
      "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00S80QZY8QB7FSRVFF";

    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT00EXEKCZ140TBBFB97",
        initiatorProfile: INITIATOR_PROFILE,
        issuerProxyUrl: "https://proxy-a.example.com",
        ticket: createdTicket.ticket,
        publicKeyX: createdTicket.publicKeyX,
        allowResponderAgentDid: allowedResponderAgentDid,
        expiresAtMs: 1_700_000_060_000,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: ticketBody.ticket,
        responderAgentDid:
          "did:cdi:dev.registry.clawdentity.com:agent:01HF7YAT7NQWWJ9ZXM8P9J8H4C",
        responderProfile: RESPONDER_PROFILE,
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(403);
    expect(
      (await confirmResponse.json()) as { error: { code: string } },
    ).toEqual({
      error: {
        code: "PROXY_PAIR_RESPONDER_FORBIDDEN",
        message: "Responder agent DID is not allowed for this pairing ticket",
      },
    });
  });
});
