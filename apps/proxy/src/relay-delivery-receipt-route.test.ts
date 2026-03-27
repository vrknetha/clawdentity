import { describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        if (c.req.header("x-test-missing-auth") !== "1") {
          c.set("auth", {
            agentDid:
              c.req.header("x-test-auth-agent-did") ??
              "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
            ownerDid:
              "did:cdi:registry.clawdentity.dev:human:01HF7YAT00S80QZY8QB7FSRVFF",
            issuer: "https://registry.example.com",
            aitJti: "ait-jti-alpha",
            cnfPublicKey: "test-public-key",
          });
        }

        await next();
      }),
  };
});

import type {
  AgentRelaySessionNamespace,
  AgentRelaySessionStub,
  RelayReceiptLookupInput,
  RelayReceiptRecordInput,
} from "./agent-relay-session.js";
import { parseProxyConfig } from "./config.js";
import type { ProxyTrustStore } from "./proxy-trust-store.js";
import { RELAY_DELIVERY_RECEIPTS_PATH } from "./relay-delivery-receipt-route.js";
import { createProxyApp } from "./server.js";

function createRelayReceiptHarness(input?: {
  lookupFound?: boolean;
  lookupReceiptState?:
    | "queued"
    | "delivered"
    | "processed_by_openclaw"
    | "dead_lettered";
  recordStatus?: number;
  lookupStatus?: number;
}) {
  const recordInputs: RelayReceiptRecordInput[] = [];
  const lookupInputs: RelayReceiptLookupInput[] = [];

  const relayStub: AgentRelaySessionStub = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        url.pathname === "/rpc/record-delivery-receipt"
      ) {
        const payload = (await request.json()) as RelayReceiptRecordInput;
        recordInputs.push(payload);

        const status = input?.recordStatus ?? 202;
        if (status >= 400) {
          return new Response("record failed", { status });
        }

        return Response.json({ accepted: true }, { status });
      }

      if (
        request.method === "POST" &&
        url.pathname === "/rpc/get-delivery-receipt"
      ) {
        const payload = (await request.json()) as RelayReceiptLookupInput;
        lookupInputs.push(payload);

        const status = input?.lookupStatus ?? 200;
        if (status >= 400) {
          return new Response("lookup failed", { status });
        }

        const found = input?.lookupFound ?? true;
        return Response.json(
          found
            ? {
                found: true,
                receipt: {
                  deliveryId: "dlv_1",
                  requestId: payload.requestId,
                  state: input?.lookupReceiptState ?? "processed_by_openclaw",
                  senderAgentDid: payload.senderAgentDid,
                  recipientAgentDid:
                    "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
                  statusUpdatedAt: "2026-02-20T00:00:00.000Z",
                  expiresAtMs: Date.now() + 60_000,
                },
              }
            : { found: false },
          { status },
        );
      }

      return new Response("not found", { status: 404 });
    }),
  };

  const doId = { toString: () => "relay-do" } as unknown as DurableObjectId;

  return {
    recordInputs,
    lookupInputs,
    namespace: {
      idFromName: vi.fn((_name: string) => doId),
      get: vi.fn((_id: DurableObjectId) => relayStub),
    } satisfies AgentRelaySessionNamespace,
  };
}

function createApp(input: {
  allowedPairs: Array<{ initiator: string; responder: string }>;
}) {
  const trustStore: ProxyTrustStore = {
    createPairingTicket: vi.fn(),
    confirmPairingTicket: vi.fn(),
    getPairingTicketStatus: vi.fn(),
    isAgentKnown: vi.fn(async () => true),
    isPairAllowed: vi.fn(async (pair) =>
      input.allowedPairs.some(
        (allowed) =>
          allowed.initiator === pair.initiatorAgentDid &&
          allowed.responder === pair.responderAgentDid,
      ),
    ),
    upsertPair: vi.fn(async () => {}),
  };

  return createProxyApp({
    config: parseProxyConfig({}),
    trustStore,
  });
}

function createReceiptQueueHarness() {
  const sentMessages: string[] = [];
  return {
    sentMessages,
    queue: {
      send: vi.fn(async (body: string) => {
        sentMessages.push(body);
      }),
      sendBatch: vi.fn(async (messages: MessageSendRequest<string>[]) => {
        for (const message of messages) {
          sentMessages.push(message.body);
        }
      }),
    } as unknown as Queue<string>,
  };
}

describe("relay delivery receipt route", () => {
  it("accepts POST receipt updates via direct DO only when ENVIRONMENT is explicitly local", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-1",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
        ENVIRONMENT: "local",
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(relayHarness.recordInputs).toHaveLength(1);
    expect(relayHarness.recordInputs[0]?.requestId).toBe("req-1");
    expect(relayHarness.recordInputs[0]?.status).toBe("processed_by_openclaw");
  });

  it("publishes receipt events to queue when RECEIPT_QUEUE binding is configured", async () => {
    const relayHarness = createRelayReceiptHarness();
    const queueHarness = createReceiptQueueHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-queue-1",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
        RECEIPT_QUEUE: queueHarness.queue,
      },
    );

    expect(response.status).toBe(202);
    expect(queueHarness.sentMessages).toHaveLength(1);
    expect(relayHarness.recordInputs).toHaveLength(0);
    const queued = JSON.parse(queueHarness.sentMessages[0] ?? "{}") as {
      type?: string;
      requestId?: string;
      status?: string;
    };
    expect(queued.type).toBe("delivery_receipt");
    expect(queued.requestId).toBe("req-queue-1");
    expect(queued.status).toBe("processed_by_openclaw");
  });

  it("publishes dead_lettered receipt events to queue without direct DO writes", async () => {
    const relayHarness = createRelayReceiptHarness();
    const queueHarness = createReceiptQueueHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-queue-dead",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "dead_lettered",
          reason: "openclaw hook failed",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
        RECEIPT_QUEUE: queueHarness.queue,
      },
    );

    expect(response.status).toBe(202);
    expect(queueHarness.sentMessages).toHaveLength(1);
    expect(relayHarness.recordInputs).toHaveLength(0);
    const queued = JSON.parse(queueHarness.sentMessages[0] ?? "{}") as {
      type?: string;
      requestId?: string;
      status?: string;
      reason?: string;
    };
    expect(queued.type).toBe("delivery_receipt");
    expect(queued.requestId).toBe("req-queue-dead");
    expect(queued.status).toBe("dead_lettered");
    expect(queued.reason).toBe("openclaw hook failed");
  });

  it("returns 503 when queue binding is missing outside local environment", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-queue-required",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
        ENVIRONMENT: "production",
      },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_QUEUE_UNAVAILABLE");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("returns 503 when queue binding is missing and ENVIRONMENT is not set", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-queue-env-unset",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_QUEUE_UNAVAILABLE");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("rejects POST when recipient differs from authenticated agent DID", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-2",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT4TXP6AW5QNXA2Y9K43",
          status: "dead_lettered",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_FORBIDDEN");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("rejects POST when requestId is whitespace only", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "   ",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_INVALID_INPUT");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("rejects POST when senderAgentDid is whitespace only", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-6",
          senderAgentDid: "\n\t",
          recipientAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_INVALID_INPUT");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("rejects POST when recipientAgentDid is whitespace only", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
        },
      ],
    });

    const response = await app.request(
      RELAY_DELIVERY_RECEIPTS_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-claw-agent-access": "token",
        },
        body: JSON.stringify({
          requestId: "req-7",
          senderAgentDid:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          recipientAgentDid: "   ",
          status: "processed_by_openclaw",
        }),
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_INVALID_INPUT");
    expect(relayHarness.recordInputs).toHaveLength(0);
  });

  it("returns receipt on GET when trusted pair exists", async () => {
    const relayHarness = createRelayReceiptHarness();
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      ],
    });

    const response = await app.request(
      `${RELAY_DELIVERY_RECEIPTS_PATH}?requestId=req-3&recipientAgentDid=did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7`,
      {
        method: "GET",
        headers: {
          "x-claw-agent-access": "token",
        },
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      found: boolean;
      receipt?: { requestId: string; state: string };
    };
    expect(body.found).toBe(true);
    expect(body.receipt?.requestId).toBe("req-3");
    expect(body.receipt?.state).toBe("processed_by_openclaw");
    expect(relayHarness.lookupInputs).toHaveLength(1);
    expect(relayHarness.lookupInputs[0]?.senderAgentDid).toBe(
      "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
    );
  });

  it("returns 404 on GET when receipt is not found", async () => {
    const relayHarness = createRelayReceiptHarness({
      lookupFound: false,
    });
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      ],
    });

    const response = await app.request(
      `${RELAY_DELIVERY_RECEIPTS_PATH}?requestId=req-4&recipientAgentDid=did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7`,
      {
        method: "GET",
        headers: {
          "x-claw-agent-access": "token",
        },
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ found: false });
  });

  it("returns 502 on GET when relay receipt lookup RPC fails", async () => {
    const relayHarness = createRelayReceiptHarness({
      lookupStatus: 500,
    });
    const app = createApp({
      allowedPairs: [
        {
          initiator:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT00EXEKCZ140TBBFB97",
          responder:
            "did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        },
      ],
    });

    const response = await app.request(
      `${RELAY_DELIVERY_RECEIPTS_PATH}?requestId=req-5&recipientAgentDid=did:cdi:registry.clawdentity.dev:agent:01HF7YAT31JZHSMW1CG6Q6MHB7`,
      {
        method: "GET",
        headers: {
          "x-claw-agent-access": "token",
        },
      },
      {
        AGENT_RELAY_SESSION: relayHarness.namespace,
      },
    );

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_RECEIPT_READ_FAILED");
  });
});
