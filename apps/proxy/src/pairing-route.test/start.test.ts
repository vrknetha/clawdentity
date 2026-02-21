import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
  parsePairingTicket,
} from "../pairing-ticket.js";

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
const _RESPONDER_PROFILE_WITH_PROXY_ORIGIN = {
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
import { PAIR_START_PATH } from "../pairing-constants.js";
import { createInMemoryProxyTrustStore } from "../proxy-trust-store.js";
import { createProxyApp } from "../server.js";

async function _createSignedTicketFixture(input: {
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
