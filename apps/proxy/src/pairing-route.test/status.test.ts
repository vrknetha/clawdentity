import {
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
} from "../pairing-ticket.js";

const DID_AUTHORITY = "registry.clawdentity.com";
const INITIATOR_AGENT_DID = makeAgentDid(
  DID_AUTHORITY,
  generateUlid(1_700_000_000_000),
);
const RESPONDER_AGENT_DID = makeAgentDid(
  DID_AUTHORITY,
  generateUlid(1_700_000_000_100),
);
const OWNER_DID = makeHumanDid(DID_AUTHORITY, "01HF7YAT31JZHSMW1CG6Q6MHB7");
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
import { PAIR_STATUS_PATH } from "../pairing-constants.js";
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
  confirmFetchImpl?: typeof fetch;
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
        fetchImpl: input?.confirmFetchImpl,
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

describe(`POST ${PAIR_STATUS_PATH}`, () => {
  it("returns pending status to initiator before ticket is confirmed", async () => {
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

    const response = await app.request(PAIR_STATUS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": INITIATOR_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
      }),
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json()) as {
        status: string;
        initiatorAgentDid: string;
        initiatorProfile: {
          agentName: string;
          humanName: string;
        };
      },
    ).toMatchObject({
      status: "pending",
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      expiresAt: "2023-11-14T22:28:20.000Z",
    });
  });

  it("returns confirmed status to initiator after responder confirms ticket", async () => {
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
    await trustStore.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      nowMs: 1_700_000_000_200,
    });

    const response = await app.request(PAIR_STATUS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": INITIATOR_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
      }),
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json()) as {
        status: string;
        initiatorAgentDid: string;
        initiatorProfile: {
          agentName: string;
          humanName: string;
        };
        responderAgentDid: string;
        responderProfile: {
          agentName: string;
          humanName: string;
        };
      },
    ).toMatchObject({
      status: "confirmed",
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      expiresAt: "2023-11-14T22:28:20.000Z",
      confirmedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("rejects status lookups from non-participant agents", async () => {
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

    const response = await app.request(PAIR_STATUS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": makeAgentDid(
          DID_AUTHORITY,
          generateUlid(1_700_000_000_300),
        ),
      },
      body: JSON.stringify({
        ticket: ticket.ticket,
      }),
    });

    expect(response.status).toBe(403);
    expect(
      (await response.json()) as { error: { code: string } },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_STATUS_FORBIDDEN",
        message: "Caller is not a participant for this pairing ticket",
      },
    });
  });
});
