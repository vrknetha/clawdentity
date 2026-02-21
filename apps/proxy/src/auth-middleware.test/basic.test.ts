import { describe, expect, it } from "vitest";
import { PAIR_CONFIRM_PATH, PAIR_STATUS_PATH } from "../pairing-constants.js";
import { BODY_JSON, createAuthHarness } from "./helpers.js";

describe("proxy auth middleware", () => {
  it("keeps /health open without auth headers", async () => {
    const harness = await createAuthHarness();
    const response = await harness.app.request("/health");

    expect(response.status).toBe(200);
  });

  it("verifies inbound auth and exposes auth context to downstream handlers", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders();
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      auth: {
        agentDid: string;
        ownerDid: string;
        aitJti: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.auth.agentDid).toBe(harness.claims.sub);
    expect(body.auth.ownerDid).toBe(harness.claims.ownerDid);
    expect(body.auth.aitJti).toBe(harness.claims.jti);
  });

  it("returns 403 when a verified caller is not trusted by agent DID", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-not-trusted",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_FORBIDDEN");
  });

  it("allows unknown agents to reach /pair/confirm for pairing bootstrap", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
    });
    const requestBody = JSON.stringify({
      ticket: "clwpair1_missing-ticket",
      responderProfile: {
        agentName: "beta",
        humanName: "Ira",
      },
    });
    const headers = await harness.createSignedHeaders({
      body: requestBody,
      nonce: "nonce-pair-confirm-bootstrap",
      pathWithQuery: PAIR_CONFIRM_PATH,
    });

    const response = await harness.app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers,
      body: requestBody,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_TICKET_INVALID_FORMAT");
  });

  it("allows unknown agents to reach /pair/status for initiator polling bootstrap", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
    });
    const requestBody = JSON.stringify({ ticket: "clwpair1_missing-ticket" });
    const headers = await harness.createSignedHeaders({
      body: requestBody,
      nonce: "nonce-pair-status-bootstrap",
      pathWithQuery: PAIR_STATUS_PATH,
    });

    const response = await harness.app.request(PAIR_STATUS_PATH, {
      method: "POST",
      headers,
      body: requestBody,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_PAIR_TICKET_INVALID_FORMAT");
  });

  it("rejects /pair/confirm without Authorization", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
    });

    const response = await harness.app.request(PAIR_CONFIRM_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket: "clwpair1_missing-ticket",
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_MISSING_TOKEN");
  });
});
