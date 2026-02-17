import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { createPairingTicket } from "./pairing-ticket.js";

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

function createPairingApp(input?: {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}) {
  const trustStore = createInMemoryProxyTrustStore();
  const app = createProxyApp({
    config: parseProxyConfig({
      REGISTRY_URL: "https://registry.example.com",
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
    const fetchMock = vi.fn(async (_requestInput: unknown) =>
      Response.json(
        {
          ownsAgent: true,
        },
        { status: 200 },
      ),
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
    expect(body.expiresAt).toBe("2023-11-14T22:28:20.000Z");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const fetchCallUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(fetchCallUrl).toContain("/v1/agents/");
    expect(fetchCallUrl).toContain("/ownership");
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
});

describe(`POST ${PAIR_CONFIRM_PATH}`, () => {
  it("confirms local issuer tickets and enables mutual trust", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });

    const ticket = await trustStore.createPairingTicket({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      issuerProxyUrl: "http://localhost",
      ttlSeconds: 900,
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
    const forwardFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe("https://issuer.proxy.example/pair/confirm");
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

    const created = createPairingTicket({
      issuerProxyUrl: "https://issuer.proxy.example",
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
        ticket: created.ticket,
      }),
    });

    expect(response.status).toBe(201);
    expect(forwardFetch).toHaveBeenCalledTimes(1);
    expect(
      await trustStore.isPairAllowed({
        initiatorAgentDid: INITIATOR_AGENT_DID,
        responderAgentDid: RESPONDER_AGENT_DID,
      }),
    ).toBe(true);
  });
});
