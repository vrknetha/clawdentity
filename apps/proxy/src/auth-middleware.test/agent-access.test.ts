import { describe, expect, it } from "vitest";
import { RELAY_RECIPIENT_AGENT_DID_HEADER } from "../agent-hook-route.js";
import { RELAY_CONNECT_PATH } from "../relay-connect-route.js";
import { BODY_JSON, createAuthHarness } from "./helpers.js";

describe("proxy auth middleware", () => {
  it("requires x-claw-agent-access for /hooks/agent", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      pathWithQuery: "/hooks/agent",
      nonce: "nonce-hooks-agent-access-required",
    });
    const response = await harness.app.request("/hooks/agent", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AGENT_ACCESS_REQUIRED");
  });

  it("rejects /hooks/agent when registry access-token validation fails", async () => {
    const harness = await createAuthHarness({
      validateStatus: 401,
    });
    const headers = await harness.createSignedHeaders({
      pathWithQuery: "/hooks/agent",
      nonce: "nonce-hooks-agent-access-invalid",
    });
    const response = await harness.app.request("/hooks/agent", {
      method: "POST",
      headers: {
        ...headers,
        "x-claw-agent-access": "clw_agt_invalid",
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AGENT_ACCESS_INVALID");
  });

  it("accepts /hooks/agent when x-claw-agent-access validates", async () => {
    const harness = await createAuthHarness({
      validateStatus: 204,
    });
    const headers = await harness.createSignedHeaders({
      pathWithQuery: "/hooks/agent",
      nonce: "nonce-hooks-agent-access-valid",
    });
    const response = await harness.app.request("/hooks/agent", {
      method: "POST",
      headers: {
        ...headers,
        "x-claw-agent-access": "clw_agt_validtoken",
        [RELAY_RECIPIENT_AGENT_DID_HEADER]: harness.claims.sub,
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(202);
  });

  it("requires x-claw-agent-access for relay websocket connect", async () => {
    const harness = await createAuthHarness({
      validateStatus: 204,
    });
    const headers = await harness.createSignedHeaders({
      method: "GET",
      pathWithQuery: RELAY_CONNECT_PATH,
      nonce: "nonce-relay-connect",
    });
    const response = await harness.app.request(RELAY_CONNECT_PATH, {
      method: "GET",
      headers: {
        ...headers,
        upgrade: "websocket",
      },
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AGENT_ACCESS_REQUIRED");
  });

  it("accepts relay websocket connect when x-claw-agent-access validates", async () => {
    const harness = await createAuthHarness({
      validateStatus: 204,
    });
    const headers = await harness.createSignedHeaders({
      method: "GET",
      pathWithQuery: RELAY_CONNECT_PATH,
      nonce: "nonce-relay-connect-agent-access-valid",
    });
    const response = await harness.app.request(RELAY_CONNECT_PATH, {
      method: "GET",
      headers: {
        ...headers,
        upgrade: "websocket",
        "x-claw-agent-access": "clw_agt_validtoken",
      },
    });

    expect(response.status).toBe(204);
  });

  it("allows unknown agents to connect relay websocket when auth validates", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
      validateStatus: 204,
    });
    const headers = await harness.createSignedHeaders({
      method: "GET",
      pathWithQuery: RELAY_CONNECT_PATH,
      nonce: "nonce-relay-connect-unknown-agent",
    });
    const response = await harness.app.request(RELAY_CONNECT_PATH, {
      method: "GET",
      headers: {
        ...headers,
        upgrade: "websocket",
        "x-claw-agent-access": "clw_agt_validtoken",
      },
    });

    expect(response.status).toBe(204);
  });
});
