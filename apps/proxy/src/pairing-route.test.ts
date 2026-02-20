import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
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
const RESPONDER_PROFILE_WITH_PROXY_ORIGIN = {
  ...RESPONDER_PROFILE,
  proxyOrigin: "https://beta.proxy.example",
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
    const startFetchImpl = fetchMock as unknown as typeof fetch;

    const { app } = createPairingApp({
      startFetchImpl,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
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
    expect(startFetchImpl).toHaveBeenCalledTimes(1);
    const ownershipCallUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(ownershipCallUrl).toContain("/internal/v1/identity/agent-ownership");
    const ownershipCallInit = fetchMock.mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const ownershipHeaders = new Headers(ownershipCallInit?.headers);
    expect(ownershipHeaders.get("x-claw-service-id")).toBe(
      "01HF7YAT00W6W7CM7N3W5FDXT4",
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
    const startFetchImpl = fetchMock as unknown as typeof fetch;

    const { app } = createPairingApp({
      startFetchImpl,
      nowMs: () => 1_700_000_000_123,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
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
    const startFetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: false,
          agentStatus: "active",
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ startFetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNERSHIP_FORBIDDEN");
  });

  it("keeps strict dependency failures when ownership lookup is unavailable", async () => {
    const startFetchImpl = vi.fn(async () => {
      throw new Error("registry unavailable");
    }) as unknown as typeof fetch;
    const { app } = createPairingApp({
      environment: "development",
      startFetchImpl,
      nowMs: () => 1_700_000_000_123,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
      }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNERSHIP_UNAVAILABLE");
  });

  it("accepts optional allowResponderAgentDid and callbackUrl", async () => {
    const startFetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: true,
          agentStatus: "active",
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({
      startFetchImpl,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        allowResponderAgentDid: RESPONDER_AGENT_DID,
        callbackUrl: "https://callbacks.example.com/pair/complete",
      }),
    });

    expect(response.status).toBe(200);
  });

  it("rejects invalid callbackUrl", async () => {
    const startFetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: true,
          agentStatus: "active",
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ startFetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        callbackUrl: "ftp://callbacks.example.com/pair/complete",
      }),
    });

    expect(response.status).toBe(400);
    expect(
      (await response.json()) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_INVALID_BODY",
        message: "callbackUrl must be a valid http(s) URL",
      },
    });
  });

  it("rejects empty allowResponderAgentDid", async () => {
    const startFetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: true,
          agentStatus: "active",
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ startFetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        initiatorProfile: INITIATOR_PROFILE,
        allowResponderAgentDid: "   ",
      }),
    });

    expect(response.status).toBe(400);
    expect(
      (await response.json()) as { error: { code: string; message: string } },
    ).toMatchObject({
      error: {
        code: "PROXY_PAIR_INVALID_BODY",
        message: "allowResponderAgentDid must be a non-empty string",
      },
    });
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

  it("posts callback on confirm and does not fail on callback errors", async () => {
    const callbackFetchMock = vi.fn(
      async (requestInput: unknown, _requestInit?: RequestInit) => {
        if (String(requestInput).includes("/success")) {
          return new Response(null, { status: 202 });
        }
        throw new Error("callback unavailable");
      },
    );
    const callbackFetch = callbackFetchMock as unknown as typeof fetch;
    const { app, trustStore } = createPairingApp({
      confirmFetchImpl: callbackFetch,
      nowMs: () => 1_700_000_000_000,
    });
    const createdTicket = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const successTicket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: createdTicket.ticket,
      publicKeyX: createdTicket.publicKeyX,
      callbackUrl: "https://callbacks.example.com/success",
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const successResponse = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: successTicket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    });

    expect(successResponse.status).toBe(201);
    expect(callbackFetchMock).toHaveBeenCalledTimes(1);
    const successCallbackRequestInit = callbackFetchMock.mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect(successCallbackRequestInit?.method).toBe("POST");
    expect(
      JSON.parse(String(successCallbackRequestInit?.body ?? "{}")) as {
        paired?: boolean;
        initiatorAgentDid?: string;
        responderAgentDid?: string;
      },
    ).toMatchObject({
      paired: true,
      initiatorAgentDid: INITIATOR_AGENT_DID,
      responderAgentDid: RESPONDER_AGENT_DID,
    });

    const failureTicketFixture = await createSignedTicketFixture({
      issuerProxyUrl: "http://localhost",
      nowMs: 1_700_000_000_010,
      expiresAtMs: 1_700_000_900_000,
    });
    const failureTicket = await trustStore.createPairingTicket({
      initiatorAgentDid: makeAgentDid(generateUlid(1_700_000_000_010)),
      initiatorProfile: INITIATOR_PROFILE,
      issuerProxyUrl: "http://localhost",
      ticket: failureTicketFixture.ticket,
      publicKeyX: failureTicketFixture.publicKeyX,
      callbackUrl: "https://callbacks.example.com/failure",
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_010,
    });
    const failureResponderAgentDid = makeAgentDid(
      generateUlid(1_700_000_000_020),
    );
    const failureResponse = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": failureResponderAgentDid,
      },
      body: JSON.stringify({
        ticket: failureTicket.ticket,
        responderProfile: RESPONDER_PROFILE_WITH_PROXY_ORIGIN,
      }),
    });

    expect(failureResponse.status).toBe(201);
    expect(callbackFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not block confirm response while callback delivery is pending", async () => {
    let resolveCallback:
      | ((value: Response | PromiseLike<Response>) => void)
      | undefined;
    const callbackFetchMock = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveCallback = resolve;
        }),
    );
    const { app, trustStore } = createPairingApp({
      confirmFetchImpl: callbackFetchMock as unknown as typeof fetch,
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
      callbackUrl: "https://callbacks.example.com/pending",
      expiresAtMs: 1_700_000_900_000,
      nowMs: 1_700_000_000_000,
    });

    const confirmPromise = Promise.resolve(
      app.request(PAIR_CONFIRM_PATH, {
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
    );

    let settled = false;
    void confirmPromise.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(settled).toBe(true);
    const response = await confirmPromise;
    expect(response.status).toBe(201);
    expect(callbackFetchMock).toHaveBeenCalledTimes(1);

    resolveCallback?.(new Response(null, { status: 202 }));
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
