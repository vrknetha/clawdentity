import { describe, expect, it } from "vitest";
import { BODY_JSON, createAuthHarness, NOW_SECONDS } from "./helpers.js";

describe("proxy auth middleware", () => {
  it("rejects non-health route when Authorization scheme is not Claw", async () => {
    const harness = await createAuthHarness();
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers: {
        authorization: "Bearer token",
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_INVALID_SCHEME");
  });

  it("rejects Authorization headers with extra segments", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-auth-extra",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers: {
        ...headers,
        authorization: `${headers.authorization} extra`,
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_INVALID_SCHEME");
  });

  it("rejects replayed nonce for the same agent", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-replay-1",
    });

    const first = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });
    const second = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_REPLAY");
  });

  it("rejects requests outside the timestamp skew window", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      timestampSeconds: NOW_SECONDS - 301,
      nonce: "nonce-old",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_TIMESTAMP_SKEW");
  });

  it.each([
    `${NOW_SECONDS}abc`,
    `${NOW_SECONDS}.5`,
  ])("rejects malformed X-Claw-Timestamp header: %s", async (malformedTimestamp) => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      timestamp: malformedTimestamp,
      nonce: "nonce-invalid-timestamp",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_INVALID_TIMESTAMP");
  });

  it("rejects proof mismatches when body is tampered", async () => {
    const harness = await createAuthHarness();
    const headers = await harness.createSignedHeaders({
      body: BODY_JSON,
      nonce: "nonce-tampered",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "tampered" }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_INVALID_PROOF");
  });

  it("rejects revoked AITs", async () => {
    const harness = await createAuthHarness({
      revoked: true,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-revoked",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_REVOKED");
  });

  it("rejects expired AITs", async () => {
    const harness = await createAuthHarness({
      expired: true,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-expired",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_INVALID_AIT");
  });

  it("returns 503 when registry signing keys are unavailable", async () => {
    const harness = await createAuthHarness({
      fetchKeysFails: true,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-keys-fail",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_DEPENDENCY_UNAVAILABLE");
  });

  it("returns 503 when CRL is unavailable in fail-closed mode", async () => {
    const harness = await createAuthHarness({
      fetchCrlFails: true,
      crlStaleBehavior: "fail-closed",
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-crl-fail-closed",
    });
    const response = await harness.app.request("/protected", {
      method: "POST",
      headers,
      body: BODY_JSON,
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_AUTH_DEPENDENCY_UNAVAILABLE");
  });
});
