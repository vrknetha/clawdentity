import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
} from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
  parsePairingTicket,
} from "./pairing-ticket.js";

const INITIATOR_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_000));
const RESPONDER_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_100));
const OWNER_DID = "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7";
const INITIATOR_PROFILE = {
  agentName: "alpha",
  humanName: "Ravi",
};
const RESPONDER_PROFILE = {
  agentName: "beta",
  humanName: "Ira",
};
const INITIATOR_E2EE = {
  keyId: "init-key-1",
  x25519PublicKey: encodeBase64url(
    Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
  ),
};
const RESPONDER_E2EE = {
  keyId: "resp-key-1",
  x25519PublicKey: encodeBase64url(
    Uint8Array.from({ length: 32 }, (_value, index) => index + 2),
  ),
};

vi.mock("./auth-middleware.js", async () => {
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

import { parseProxyConfig } from "./config.js";
import {
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
} from "./pairing-constants.js";
import { createInMemoryProxyTrustStore } from "./proxy-trust-store.js";
import { createProxyApp } from "./server.js";

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
  environment?: "local" | "development" | "production" | "test";
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}) {
  const trustStore = createInMemoryProxyTrustStore();
  const app = createProxyApp({
    config: parseProxyConfig({
      REGISTRY_URL: "https://registry.example.com",
      REGISTRY_INTERNAL_SERVICE_ID: "01KHSVCABCDEFGHJKMNOPQRST",
      REGISTRY_INTERNAL_SERVICE_SECRET:
        "clw_srv_kx2qkQhJ9j9d2l2fF6uH3m6l9Hj7sVfW8Q2r3L4",
      ENVIRONMENT: input?.environment,
    }),
    pairing: {
      start: {
        fetchImpl: input?.fetchImpl,
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

describe(`POST ${PAIR_START_PATH}`, () => {
  it("creates a pairing ticket when caller owns initiator agent DID", async () => {
    const fetchMock = vi.fn(
      async (requestInput: unknown, _requestInit?: RequestInit) => {
        const url = String(requestInput);
        if (url.includes("/internal/v1/identity/agent-ownership")) {
          return Response.json(
            {
              ownsAgent: true,
              agentStatus: "active",
            },
            { status: 200 },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const { app } = createPairingApp({
      fetchImpl,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        initiatorE2ee: INITIATOR_E2EE,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expiresAt: string;
      initiatorAgentDid: string;
      initiatorProfile: {
        agentName: string;
        humanName: string;
      };
      ticket: string;
    };

    expect(body.ticket.startsWith("clwpair1_")).toBe(true);
    expect(body.initiatorAgentDid).toBe(INITIATOR_AGENT_DID);
    expect(body.initiatorProfile).toEqual(INITIATOR_PROFILE);
    expect(body.expiresAt).toBe("2023-11-14T22:18:20.000Z");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const ownershipCallUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(ownershipCallUrl).toContain("/internal/v1/identity/agent-ownership");
    const ownershipCallInit = fetchMock.mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const ownershipHeaders = new Headers(ownershipCallInit?.headers);
    expect(ownershipHeaders.get("x-claw-service-id")).toBe(
      "01KHSVCABCDEFGHJKMNOPQRST",
    );
    expect(ownershipHeaders.get("x-claw-service-secret")).toBe(
      "clw_srv_kx2qkQhJ9j9d2l2fF6uH3m6l9Hj7sVfW8Q2r3L4",
    );
  });

  it("normalizes pairing ticket expiry to whole seconds", async () => {
    const fetchMock = vi.fn(
      async (requestInput: unknown, _requestInit?: RequestInit) => {
        const url = String(requestInput);
        if (url.includes("/internal/v1/identity/agent-ownership")) {
          return Response.json(
            { ownsAgent: true, agentStatus: "active" },
            { status: 200 },
          );
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const { app } = createPairingApp({
      fetchImpl,
      nowMs: () => 1_700_000_000_123,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        initiatorE2ee: INITIATOR_E2EE,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expiresAt: string;
      ticket: string;
    };
    expect(body.expiresAt).toBe("2023-11-14T22:18:20.000Z");
    expect(parsePairingTicket(body.ticket).exp * 1000).toBe(1_700_000_300_000);
  });

  it("returns 403 when ownership check reports caller is not owner", async () => {
    const fetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: false,
          agentStatus: "active",
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ fetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        initiatorE2ee: INITIATOR_E2EE,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNERSHIP_FORBIDDEN");
  });

  it("keeps strict dependency failures when ownership lookup is unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("registry unavailable");
    }) as unknown as typeof fetch;
    const { app } = createPairingApp({
      environment: "development",
      fetchImpl,
      nowMs: () => 1_700_000_000_123,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        initiatorE2ee: INITIATOR_E2EE,
      }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNERSHIP_UNAVAILABLE");
  });
});

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
      initiatorE2ee: INITIATOR_E2EE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
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
        responderProfile: RESPONDER_PROFILE,
        responderE2ee: RESPONDER_E2EE,
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
      initiatorE2ee: INITIATOR_E2EE,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE,
      responderE2ee: RESPONDER_E2EE,
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
});

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
      initiatorE2ee: INITIATOR_E2EE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
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
      initiatorE2ee: INITIATOR_E2EE,
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
      initiatorE2ee: INITIATOR_E2EE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });
    await trustStore.confirmPairingTicket({
      ticket: ticket.ticket,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE,
      responderE2ee: RESPONDER_E2EE,
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
      initiatorE2ee: INITIATOR_E2EE,
      responderAgentDid: RESPONDER_AGENT_DID,
      responderProfile: RESPONDER_PROFILE,
      responderE2ee: RESPONDER_E2EE,
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
      initiatorE2ee: INITIATOR_E2EE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_STATUS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": makeAgentDid(generateUlid(1_700_000_000_300)),
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
