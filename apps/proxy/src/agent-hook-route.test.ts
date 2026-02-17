import { describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        const missingAuth = c.req.header("x-test-missing-auth") === "1";
        if (!missingAuth) {
          const dirtyAuth = c.req.header("x-test-dirty-auth") === "1";
          c.set("auth", {
            agentDid: dirtyAuth
              ? `\u0000 did:claw:agent:${"a".repeat(200)} \n`
              : "did:claw:agent:alpha",
            ownerDid: dirtyAuth
              ? " \t did:claw:owner:alpha\u0007"
              : "did:claw:owner:alpha",
            issuer: dirtyAuth
              ? ` https://registry.example.com/${"b".repeat(260)} `
              : "https://registry.example.com",
            aitJti: dirtyAuth ? `\u0001${"j".repeat(100)}` : "ait-jti-alpha",
            cnfPublicKey: "test-public-key",
          });
        }
        await next();
      }),
  };
});

import { RELAY_RECIPIENT_AGENT_DID_HEADER } from "./agent-hook-route.js";
import type {
  AgentRelaySessionNamespace,
  AgentRelaySessionStub,
  RelayDeliveryInput,
  RelayDeliveryResult,
} from "./agent-relay-session.js";
import { parseProxyConfig } from "./config.js";
import { createProxyApp } from "./server.js";

function hasDisallowedControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12) {
      return true;
    }
    if ((code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

function createRelayHarness(input?: {
  deliverResult?: RelayDeliveryResult;
  throwOnDeliver?: boolean;
}) {
  const deliverResult = input?.deliverResult ?? {
    delivered: true,
    connectedSockets: 1,
  };
  const receivedInputs: RelayDeliveryInput[] = [];

  const fetchRpc = vi.fn(async (request: Request) => {
    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const relayInput = (await request.json()) as RelayDeliveryInput;
    receivedInputs.push(relayInput);

    if (input?.throwOnDeliver) {
      return new Response("delivery failed", { status: 502 });
    }

    return Response.json(deliverResult, { status: 202 });
  });

  const relaySession: AgentRelaySessionStub = {
    fetch: fetchRpc,
  };

  const durableObjectId = {
    toString: () => "relay-session-id",
  } as unknown as DurableObjectId;

  const idFromName = vi.fn((_name: string) => durableObjectId);
  const get = vi.fn((_id: DurableObjectId) => relaySession);

  return {
    idFromName,
    get,
    fetchRpc,
    receivedInputs,
    namespace: {
      idFromName,
      get,
    } satisfies AgentRelaySessionNamespace,
  };
}

function createHookRouteApp(input: {
  relayNamespace?: AgentRelaySessionNamespace;
  injectIdentityIntoMessage?: boolean;
  now?: () => Date;
}) {
  return createProxyApp({
    config: parseProxyConfig({
      INJECT_IDENTITY_INTO_MESSAGE: input.injectIdentityIntoMessage,
    }),
    hooks: {
      now: input.now,
      resolveSessionNamespace: () => input.relayNamespace,
    },
  });
}

describe("POST /hooks/agent", () => {
  it("delivers hook payload to recipient relay session", async () => {
    const relayHarness = createRelayHarness();
    const now = new Date("2026-02-16T20:00:00.000Z");
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
      now: () => now,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({
        event: "agent.started",
      }),
    });

    expect(response.status).toBe(202);
    expect(relayHarness.idFromName).toHaveBeenCalledWith(
      "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
    );
    expect(relayHarness.get).toHaveBeenCalledTimes(1);
    expect(relayHarness.fetchRpc).toHaveBeenCalledTimes(1);
    const [relayInput] = relayHarness.receivedInputs;
    expect(relayInput.senderAgentDid).toBe("did:claw:agent:alpha");
    expect(relayInput.recipientAgentDid).toBe(
      "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
    );
    expect(relayInput.payload).toEqual({ event: "agent.started" });
    expect(typeof relayInput.requestId).toBe("string");
    expect(relayInput.requestId.length).toBeGreaterThan(0);

    const body = (await response.json()) as {
      accepted: boolean;
      delivered: boolean;
      connectedSockets: number;
    };
    expect(body).toEqual({
      accepted: true,
      delivered: true,
      connectedSockets: 1,
    });
  });

  it("delivers through DO fetch RPC", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(202);
    expect(relayHarness.fetchRpc).toHaveBeenCalledTimes(1);
  });

  it("prepends sanitized identity block when message injection is enabled", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
      injectIdentityIntoMessage: true,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({
        message: "Summarize this payload",
      }),
    });

    expect(response.status).toBe(202);
    const [relayInput] = relayHarness.receivedInputs;
    const forwardedPayload = relayInput.payload as {
      message: string;
    };

    expect(forwardedPayload.message).toBe(
      [
        "[Clawdentity Identity]",
        "agentDid: did:claw:agent:alpha",
        "ownerDid: did:claw:owner:alpha",
        "issuer: https://registry.example.com",
        "aitJti: ait-jti-alpha",
        "",
        "Summarize this payload",
      ].join("\n"),
    );
  });

  it("keeps payload unchanged when message injection is enabled but auth is missing", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
      injectIdentityIntoMessage: true,
    });
    const rawPayload = {
      message: "No auth context here",
      event: "agent.started",
    };

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        "x-test-missing-auth": "1",
      },
      body: JSON.stringify(rawPayload),
    });

    expect(response.status).toBe(500);
  });

  it("keeps payload unchanged when message is missing or non-string", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
      injectIdentityIntoMessage: true,
    });

    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({
        event: "agent.started",
      }),
    });

    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({
        message: { nested: true },
      }),
    });

    const [firstRelayInput, secondRelayInput] = relayHarness.receivedInputs;

    expect(firstRelayInput.payload).toEqual({ event: "agent.started" });
    expect(secondRelayInput.payload).toEqual({ message: { nested: true } });
  });

  it("sanitizes identity fields and enforces length limits", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
      injectIdentityIntoMessage: true,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        "x-test-dirty-auth": "1",
      },
      body: JSON.stringify({
        message: "Hello world",
      }),
    });

    expect(response.status).toBe(202);
    const [relayInput] = relayHarness.receivedInputs;

    const forwardedPayload = relayInput.payload as {
      message: string;
    };
    expect(forwardedPayload.message).toContain("[Clawdentity Identity]");

    const identityBlock = forwardedPayload.message.split("\n\n")[0];
    expect(hasDisallowedControlCharacter(identityBlock)).toBe(false);

    const identityLines = identityBlock.split("\n");
    expect(identityLines[1].length).toBeLessThanOrEqual(171);
    expect(identityLines[2].length).toBeLessThanOrEqual(171);
    expect(identityLines[3].length).toBeLessThanOrEqual(208);
    expect(identityLines[4].length).toBeLessThanOrEqual(72);
  });

  it("rejects non-json content types", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: "hello",
    });

    expect(relayHarness.fetchRpc).not.toHaveBeenCalled();
    expect(response.status).toBe(415);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_UNSUPPORTED_MEDIA_TYPE");
    expect(body.error.message).toBe("Content-Type must be application/json");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("rejects invalid JSON payloads", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: "{not valid json",
    });

    expect(relayHarness.fetchRpc).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_INVALID_JSON");
    expect(body.error.message).toBe("Request body must be valid JSON");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("rejects missing recipient DID header", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_HOOK_RECIPIENT_REQUIRED");
  });

  it("rejects invalid recipient DID header", async () => {
    const relayHarness = createRelayHarness();
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]: "did:claw:human:not-agent",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_HOOK_RECIPIENT_INVALID");
  });

  it("returns 503 when relay session namespace is unavailable", async () => {
    const app = createHookRouteApp({
      relayNamespace: undefined,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_UNAVAILABLE");
  });

  it("maps relay delivery failures to 502", async () => {
    const relayHarness = createRelayHarness({ throwOnDeliver: true });
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_DELIVERY_FAILED");
  });

  it("returns 502 when target connector is offline", async () => {
    const relayHarness = createRelayHarness({
      deliverResult: {
        delivered: false,
        connectedSockets: 0,
      },
    });
    const app = createHookRouteApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]:
          "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_CONNECTOR_OFFLINE");
  });
});
