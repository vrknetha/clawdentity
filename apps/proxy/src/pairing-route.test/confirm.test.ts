import {
  generateUlid,
  makeAgentDid as protocolMakeAgentDid,
  makeHumanDid as protocolMakeHumanDid,
} from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
} from "../pairing-ticket.js";

const DEFAULT_TEST_DID_AUTHORITY = "dev.registry.clawdentity.com";

function makeAgentDid(
  id: string,
  authority = DEFAULT_TEST_DID_AUTHORITY,
): string {
  return protocolMakeAgentDid(authority, id);
}

function makeHumanDid(
  id: string,
  authority = DEFAULT_TEST_DID_AUTHORITY,
): string {
  return protocolMakeHumanDid(authority, id);
}

const INITIATOR_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_000));
const RESPONDER_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_100));
const OWNER_DID = makeHumanDid("01HF7YAT31JZHSMW1CG6Q6MHB7");
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

vi.mock("../auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        c.set("auth", {
          agentDid: c.req.header("x-test-agent-did") ?? INITIATOR_AGENT_DID,
          ownerDid: c.req.header("x-test-owner-did") ?? OWNER_DID,
          issuer: "https://registry.clawdentity.com",
          aitJti: "test-ait-jti",
          cnfPublicKey: "test-key",
        });
        await next();
      }),
  };
});

import { parseProxyConfig } from "../config.js";
import { PAIR_CONFIRM_PATH } from "../pairing-constants.js";
import { createInMemoryProxyTrustStore } from "../proxy-trust-store.js";
import { createProxyApp } from "../server.js";

async function createSignedTicketFixture(input: {
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
    pkid: signingKey.pkid,
  };
}

function createPairingApp(input?: {
  environment?: "local" | "development" | "production";
  startFetchImpl?: typeof fetch;
  nowMs?: () => number;
}) {
  const trustStore = createInMemoryProxyTrustStore();
  const app = createProxyApp({
    config: parseProxyConfig({
      REGISTRY_URL: "https://registry.example.com",
      BOOTSTRAP_INTERNAL_SERVICE_ID: "01HF7YAT00W6W7CM7N3W5FDXT4",
      BOOTSTRAP_INTERNAL_SERVICE_SECRET:
        "clw_srv_kx2qkQhJ9j9d2l2fF6uH3m6l9Hj7sVfW8Q2r3L4",
      ENVIRONMENT: input?.environment,
    }),
    pairing: {
      start: {
        fetchImpl: input?.startFetchImpl,
        nowMs: input?.nowMs,
      },
      confirm: {
        nowMs: input?.nowMs,
      },
      status: {
        nowMs: input?.nowMs,
      },
    },
    trustStore,
  });

  return {
    app,
    trustStore,
  };
}

describe(`POST ${PAIR_CONFIRM_PATH}`, () => {
  it("confirms local issuer tickets and enables mutual trust", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });

    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      initiatorAgentDid: string;
      initiatorProfile: {
        agentName: string;
        humanName: string;
      };
      paired: boolean;
      responderAgentDid: string;
      responderProfile: {
        agentName: string;
        humanName: string;
      };
    };

    expect(body).toEqual({
      paired: true,
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
    });

    expect(
      await trustStore.isPairAllowed({
        initiatorAgentDid: INITIATOR_AGENT_DID,
        responderAgentDid: RESPONDER_AGENT_DID,
      }),
    ).toBe(true);
    expect(
      await trustStore.isPairAllowed({
        initiatorAgentDid: RESPONDER_AGENT_DID,
        responderAgentDid: INITIATOR_AGENT_DID,
      }),
    ).toBe(true);
  });

  it("rejects confirm replay with 409", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });
    const confirmRequest = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    };

    const firstResponse = await app.request(PAIR_CONFIRM_PATH, confirmRequest);
    expect(firstResponse.status).toBe(201);

    const replayResponse = await app.request(PAIR_CONFIRM_PATH, confirmRequest);
    expect(replayResponse.status).toBe(409);
    expect(
      (await replayResponse.json()) as {
        error: { code: string; message: string };
      },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_TICKET_ALREADY_CONFIRMED",
        message: "Pairing ticket has already been confirmed",
      },
    });
  });

  it("rejects responder DID mismatch when allowResponderAgentDid is set", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const allowedResponderAgentDid = makeAgentDid(
      generateUlid(1_700_000_000_200),
    );
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      allowResponderAgentDid: allowedResponderAgentDid,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    });

    expect(response.status).toBe(403);
    expect(
      (await response.json()) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_RESPONDER_FORBIDDEN",
        message: "Responder agent DID is not allowed for this pairing ticket",
      },
    });
  });

  it("publishes pair.accepted event to queue on confirm", async () => {
    const queueSendSpy = vi.fn(async (_message: string) => {});
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.fetch(
      new Request(`https://proxy.example.test${PAIR_CONFIRM_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-agent-did": RESPONDER_AGENT_DID,
        },
        body: JSON.stringify({
          ticket: ticket.ticket,
          responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
        }),
      }),
      {
        EVENTS_QUEUE: {
          send: queueSendSpy,
        } as unknown as Queue<string>,
      },
    );

    expect(response.status).toBe(201);
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
    const queuedBody = JSON.parse(
      String(queueSendSpy.mock.calls[0]?.[0] ?? "{}"),
    ) as {
      type?: string;
      message?: string;
      initiatorAgentDid?: string;
      responderAgentDid?: string;
      responderProfile?: {
        agentName?: string;
      };
      issuerProxyOrigin?: string;
    };
    expect(queuedBody).toMatchObject({
      type: "pair.accepted",
      message: "Clawdentity pairing complete. You can now message this peer.",
      initiatorAgentDid: INITIATOR_AGENT_DID,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: {
        agentName: RESPONDER_PROFILE_WITH_PROXY_ORIGIN.agentName,
      },
      issuerProxyOrigin: "http://localhost",
    });
  });

  it("keeps confirm successful when pair.accepted queue publish fails", async () => {
    const queueSendSpy = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.fetch(
      new Request(`https://proxy.example.test${PAIR_CONFIRM_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-agent-did": RESPONDER_AGENT_DID,
        },
        body: JSON.stringify({
          ticket: ticket.ticket,
          responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
        }),
      }),
      {
        EVENTS_QUEUE: {
          send: queueSendSpy,
        } as unknown as Queue<string>,
      },
    );

    expect(response.status).toBe(201);
    expect(queueSendSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects confirm when signature does not match persisted publicKeyX", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });
    const mismatchedSigningKey = await createPairingTicketSigningKey({
      nowMs: 1_700_000_000_001,
    });
    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: mismatchedSigningKey.publicKeyX,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    });

    expect(response.status).toBe(400);
    expect(
      (await response.json()) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_TICKET_INVALID_SIGNATURE",
        message: "Pairing ticket signature is invalid",
      },
    });
  });
});
