import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";

const INITIATOR_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_000));
const RESPONDER_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_100));
const INTRUDER_AGENT_DID = makeAgentDid(generateUlid(1_700_000_000_300));

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
  it("creates a pairing code when owner PAT controls caller agent DID", async () => {
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
      body: JSON.stringify({
        agentDid: RESPONDER_AGENT_DID,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      expiresAt: string;
      initiatorAgentDid: string;
      pairingCode: string;
      responderAgentDid: string;
    };

    expect(body.pairingCode.length).toBeGreaterThan(0);
    expect(body.initiatorAgentDid).toBe(INITIATOR_AGENT_DID);
    expect(body.responderAgentDid).toBe(RESPONDER_AGENT_DID);
    expect(body.expiresAt).toBe("2023-11-14T22:18:20.000Z");
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
      body: JSON.stringify({
        agentDid: RESPONDER_AGENT_DID,
      }),
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
      body: JSON.stringify({
        agentDid: RESPONDER_AGENT_DID,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_OWNER_PAT_FORBIDDEN");
  });
});

describe(`POST ${PAIR_CONFIRM_PATH}`, () => {
  it("consumes pairing code and enables mutual trust", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });

    const pairingCode = await trustStore.createPairingCode({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      responderAgentDid: RESPONDER_AGENT_DID,
      ttlSeconds: 300,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": RESPONDER_AGENT_DID,
      },
      body: JSON.stringify({
        pairingCode: pairingCode.pairingCode,
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

  it("rejects pair confirm when caller does not match target agent", async () => {
    const { app, trustStore } = createPairingApp({
      nowMs: () => 1_700_000_000_000,
    });

    const pairingCode = await trustStore.createPairingCode({
      initiatorAgentDid: INITIATOR_AGENT_DID,
      responderAgentDid: RESPONDER_AGENT_DID,
      ttlSeconds: 300,
      nowMs: 1_700_000_000_000,
    });

    const response = await app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-agent-did": INTRUDER_AGENT_DID,
      },
      body: JSON.stringify({
        pairingCode: pairingCode.pairingCode,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_CODE_AGENT_MISMATCH");
  });
});
