import { describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        c.set("auth", {
          agentDid: "did:claw:agent:connector",
          ownerDid: "did:claw:owner:connector",
          issuer: "https://registry.example.com",
          aitJti: "ait-jti-connector",
          cnfPublicKey: "test-public-key",
        });
        await next();
      }),
  };
});

import type {
  AgentRelaySessionNamespace,
  AgentRelaySessionStub,
} from "./agent-relay-session.js";
import { parseProxyConfig } from "./config.js";
import { RELAY_CONNECT_PATH } from "./relay-connect-route.js";
import { createProxyApp } from "./server.js";

function createRelayNamespaceHarness() {
  const fetchRelaySession = vi.fn(
    async (_request: Request) => new Response(null, { status: 204 }),
  );
  const relaySession: AgentRelaySessionStub = {
    fetch: fetchRelaySession,
  };

  const durableObjectId = {
    toString: () => "connector-session-id",
  } as unknown as DurableObjectId;

  const idFromName = vi.fn((_name: string) => durableObjectId);
  const get = vi.fn((_id: DurableObjectId) => relaySession);

  return {
    idFromName,
    get,
    fetchRelaySession,
    namespace: {
      idFromName,
      get,
    } satisfies AgentRelaySessionNamespace,
  };
}

function createRelayConnectApp(input: {
  relayNamespace?: AgentRelaySessionNamespace;
}) {
  return createProxyApp({
    config: parseProxyConfig({}),
    relay: {
      resolveSessionNamespace: () => input.relayNamespace,
    },
  });
}

describe(`GET ${RELAY_CONNECT_PATH}`, () => {
  it("forwards websocket connect requests to DO session keyed by authenticated connector DID", async () => {
    const relayHarness = createRelayNamespaceHarness();
    const app = createRelayConnectApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request(RELAY_CONNECT_PATH, {
      method: "GET",
      headers: {
        upgrade: "websocket",
      },
    });

    expect(response.status).toBe(204);
    expect(relayHarness.idFromName).toHaveBeenCalledWith(
      "did:claw:agent:connector",
    );
    expect(relayHarness.get).toHaveBeenCalledTimes(1);
    expect(relayHarness.fetchRelaySession).toHaveBeenCalledTimes(1);

    const [forwardedRequest] = relayHarness.fetchRelaySession.mock.calls[0] as [
      Request,
    ];
    expect(forwardedRequest.headers.get("x-claw-connector-agent-did")).toBe(
      "did:claw:agent:connector",
    );
  });

  it("requires websocket upgrade header", async () => {
    const relayHarness = createRelayNamespaceHarness();
    const app = createRelayConnectApp({
      relayNamespace: relayHarness.namespace,
    });

    const response = await app.request(RELAY_CONNECT_PATH, {
      method: "GET",
    });

    expect(response.status).toBe(426);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_UPGRADE_REQUIRED");
  });

  it("returns 503 when relay session namespace is unavailable", async () => {
    const app = createRelayConnectApp({
      relayNamespace: undefined,
    });

    const response = await app.request(RELAY_CONNECT_PATH, {
      method: "GET",
      headers: {
        upgrade: "websocket",
      },
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_RELAY_UNAVAILABLE");
  });
});
