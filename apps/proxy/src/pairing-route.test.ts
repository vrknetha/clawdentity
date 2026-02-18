import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
  parsePairingTicket,
} from "./pairing-ticket.js";

const INITIATOR_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_000));
const RESPONDER_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_100));

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        c.set("auth", {
          agentDid: c.req.header("x-test-agent-did") ?? INITIATOR_AGENT_DID,
          ownerDid: c.req.header("x-test-owner-did") ?? "did:claw:human:owner",
          issuer: "https://api.clawdentity.com",
          aitJti: "test-ait-jti",
          cnfPublicKey: "test-key",
        });
        await next();
      }),
  };
});

import { parseProxyConfig } from "./config.js";
import {
  OWNER_PAT_HEADER,
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
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
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  pairingIssuerUrl?: string;
}) {
  const trustStore = createInMemoryProxyTrustStore();
  const app = createProxyApp({
    config: parseProxyConfig({
      REGISTRY_URL: "https://registry.example.com",
      PAIRING_ISSUER_URL: input?.pairingIssuerUrl,
    }),
    pairing: {
      start: {
        fetchImpl: input?.fetchImpl,
        nowMs: input?.nowMs,
      },
      confirm: {
        fetchImpl: input?.fetchImpl,
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
  it("creates a pairing ticket when owner PAT controls caller agent DID", async () => {
    const fetchMock = vi.fn(async (requestInput: unknown) => {
      const url = String(requestInput);
      if (url.includes("/ownership")) {
        return Response.json(
          {
            ownsAgent: true,
          },
          { status: 200 },
        );
      }

      if (url.includes("/v1/proxy-pairing-keys")) {
        return Response.json({ ok: true }, { status: 201 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const { app } = createPairingApp({
      fetchImpl,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OWNER_PAT_HEADER]: "clw_pat_owner_token",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expiresAt: string;
      initiatorAgentDid: string;
      ticket: string;
    };

    expect(body.ticket.startsWith("clwpair1_")).toBe(true);
    expect(body.initiatorAgentDid).toBe(INITIATOR_AGENT_DID);
    expect(body.expiresAt).toBe("2023-11-14T22:18:20.000Z");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const ownershipCallUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(ownershipCallUrl).toContain("/v1/agents/");
    expect(ownershipCallUrl).toContain("/ownership");
    const keyRegisterCallUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
    expect(keyRegisterCallUrl).toContain("/v1/proxy-pairing-keys");
  });

  it("normalizes pairing ticket expiry to whole seconds", async () => {
    const fetchMock = vi.fn(
      async (requestInput: unknown, _requestInit?: RequestInit) => {
        const url = String(requestInput);
        if (url.includes("/ownership")) {
          return Response.json({ ownsAgent: true }, { status: 200 });
        }

        if (url.includes("/v1/proxy-pairing-keys")) {
          return Response.json({ ok: true }, { status: 201 });
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
        [OWNER_PAT_HEADER]: "clw_pat_owner_token",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expiresAt: string;
    };
    expect(body.expiresAt).toBe("2023-11-14T22:18:20.000Z");

    const keyRegisterInit = fetchMock.mock.calls[1]?.[1] as
      | RequestInit
      | undefined;
    const keyRegisterBody = JSON.parse(
      String(keyRegisterInit?.body ?? "{}"),
    ) as {
      expiresAt?: string;
    };
    expect(keyRegisterBody.expiresAt).toBe("2023-11-14T22:18:20.000Z");
  });

  it("returns 401 when owner PAT is invalid", async () => {
    const fetchImpl = vi.fn(
      async (_requestInput: unknown) => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ fetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OWNER_PAT_HEADER]: "clw_pat_invalid",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNER_PAT_INVALID");
  });

  it("returns 403 when owner PAT does not control caller DID", async () => {
    const fetchImpl = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: false,
        },
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const { app } = createPairingApp({ fetchImpl });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OWNER_PAT_HEADER]: "clw_pat_owner",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNER_PAT_FORBIDDEN");
  });

  it("uses configured pairing issuer URL when creating ticket", async () => {
    const fetchImpl = vi.fn(async (requestInput: unknown) => {
      const url = String(requestInput);
      if (url.includes("/ownership")) {
        return Response.json({ ownsAgent: true }, { status: 200 });
      }

      if (url.includes("/v1/proxy-pairing-keys")) {
        return Response.json({ ok: true }, { status: 201 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;
    const { app } = createPairingApp({
      fetchImpl,
      nowMs: () => 1_700_000_000_000,
      pairingIssuerUrl: "http://127.0.0.1:8788",
    });

    const response = await app.request(PAIR_START_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OWNER_PAT_HEADER]: "clw_pat_owner_token",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ticket: string;
    };
    const parsedTicket = parsePairingTicket(body.ticket);
    expect(parsedTicket.iss).toBe("http://127.0.0.1:8788");
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
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      initiatorAgentDid: string;
      paired: boolean;
      responderAgentDid: string;
    };

    expect(body).toEqual({
      paired: true,
      initiatorAgentDid: INITIATOR_AGENT_DID,
      responderAgentDid: RESPONDER_AGENT_DID,
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

  it("forwards confirm to issuer proxy when ticket issuer differs", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "https://issuer.proxy.example",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const forwardFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      expect(urlString).toBe(
        `https://issuer.proxy.example/pair/confirm?responderAgentDid=${encodeURIComponent(RESPONDER_AGENT_DID)}`,
      );
      const forwardedBody = JSON.parse(String(init?.body ?? "{}")) as {
        ticket: string;
      };
      expect(forwardedBody.ticket.startsWith("clwpair1_")).toBe(true);

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: INITIATOR_AGENT_DID,
          responderAgentDid: RESPONDER_AGENT_DID,
        },
        { status: 201 },
      );
    });

    const { app, trustStore } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: created.ticket,
      }),
    });

    expect(response.status).toBe(201);
    expect(forwardFetch).toHaveBeenCalledTimes(2);
    expect(
      await trustStore.isPairAllowed({
        initiatorAgentDid: INITIATOR_AGENT_DID,
        responderAgentDid: RESPONDER_AGENT_DID,
      }),
    ).toBe(true);
  });

  it("rejects forwarded confirm when issuer key cannot be resolved", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "https://issuer.proxy.example",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const fetchImpl = vi.fn(async (url: unknown) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return new Response(null, { status: 404 });
      }

      throw new Error(`Unexpected URL: ${urlString}`);
    }) as unknown as typeof fetch;

    const { app } = createPairingApp({
      fetchImpl,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: created.ticket,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_TICKET_UNTRUSTED_ISSUER");
  });

  it("rejects forwarding to blocked issuer origin for non-local proxy origins", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "http://127.0.0.1:8787",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const forwardFetch = vi.fn(async (url: unknown) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      throw new Error("forward fetch should not be called");
    });

    const { app } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(
      "https://proxy.public.example/pair/confirm",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-agent-did": RESPONDER_AGENT_DID,
        },
        body: JSON.stringify({
          ticket: created.ticket,
        }),
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_TICKET_ISSUER_BLOCKED");
    expect(forwardFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP issuer origin when proxy is non-local", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "http://issuer.proxy.example",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const forwardFetch = vi.fn(async (url: unknown) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      throw new Error("forward fetch should not be called");
    });

    const { app } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(
      "https://proxy.public.example/pair/confirm",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-agent-did": RESPONDER_AGENT_DID,
        },
        body: JSON.stringify({
          ticket: created.ticket,
        }),
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_CONFIRM_ISSUER_INSECURE");
    expect(forwardFetch).toHaveBeenCalledTimes(1);
  });

  it("allows HTTP issuer origin when both proxy and issuer are local", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "http://127.0.0.1:8787",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const forwardFetch = vi.fn(async (url: unknown) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      expect(urlString).toBe(
        `http://127.0.0.1:8787/pair/confirm?responderAgentDid=${encodeURIComponent(RESPONDER_AGENT_DID)}`,
      );

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: INITIATOR_AGENT_DID,
          responderAgentDid: RESPONDER_AGENT_DID,
        },
        { status: 201 },
      );
    });

    const { app, trustStore } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request("http://localhost/pair/confirm", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        ticket: created.ticket,
      }),
    });

    expect(response.status).toBe(201);
    expect(forwardFetch).toHaveBeenCalledTimes(2);
    expect(
      await trustStore.isPairAllowed({
        initiatorAgentDid: INITIATOR_AGENT_DID,
        responderAgentDid: RESPONDER_AGENT_DID,
      }),
    ).toBe(true);
  });

  it("preserves original signed JSON body when forwarding to issuer proxy", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "https://issuer.proxy.example",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    let expectedBody = "";
    const forwardFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      expect(String(init?.body ?? "")).toBe(expectedBody);
      return Response.json(
        {
          paired: true,
          initiatorAgentDid: INITIATOR_AGENT_DID,
          responderAgentDid: RESPONDER_AGENT_DID,
        },
        { status: 201 },
      );
    });

    const { app } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const bodyRaw = `{  "ticket":"${created.ticket}",  "extra":"value" }`;
    expectedBody = bodyRaw;

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: bodyRaw,
    });

    expect(response.status).toBe(201);
    expect(forwardFetch).toHaveBeenCalledTimes(2);
    const forwardedBody = String(
      (forwardFetch.mock.calls[1]?.[1] as RequestInit | undefined)?.body ?? "",
    );
    expect(forwardedBody).toBe(bodyRaw);
  });

  it("forwards only required confirmation headers", async () => {
    const created = await createSignedTicketFixture({
      issuerProxyUrl: "https://issuer.proxy.example",
      nowMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_900_000,
    });

    const forwardFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const urlString = String(url);
      if (urlString.includes("/v1/proxy-pairing-keys/resolve")) {
        return Response.json(
          {
            key: {
              publicKeyX: created.publicKeyX,
            },
          },
          { status: 200 },
        );
      }

      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-claw-proof")).toBeNull();
      expect(headers.get("x-claw-body-sha256")).toBeNull();
      expect(headers.get("x-claw-timestamp")).toBeNull();
      expect(headers.get("x-claw-nonce")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-forwarded-for")).toBeNull();

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: INITIATOR_AGENT_DID,
          responderAgentDid: RESPONDER_AGENT_DID,
        },
        { status: 201 },
      );
    });

    const { app } = createPairingApp({
      fetchImpl: forwardFetch as unknown as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        authorization: "Claw test-token",
        "content-type": "application/json",
        "x-claw-proof": "proof",
        "x-claw-body-sha256": "sha",
        "x-claw-timestamp": "1700000000",
        "x-claw-nonce": "nonce",
        "x-forwarded-for": "10.0.0.1",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({ ticket: created.ticket }),
    });

    expect(response.status).toBe(201);
    expect(forwardFetch).toHaveBeenCalledTimes(2);
  });
});
