import { describe, expect, it, vi } from "vitest";
import { ProxyTrustState } from "./proxy-trust-state.js";
import { TRUST_STORE_ROUTES } from "./proxy-trust-store.js";

function createStorageHarness(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));

  return {
    values,
    storage: {
      get: vi.fn(async (key: string) => values.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
      }),
      setAlarm: vi.fn(async (_scheduled: number | Date) => {}),
      deleteAlarm: vi.fn(async () => {}),
    },
  };
}

function createProxyTrustState(initialStorage?: Record<string, unknown>) {
  const harness = createStorageHarness(initialStorage);
  const state = {
    storage: harness.storage,
  };

  return {
    proxyTrustState: new ProxyTrustState(
      state as unknown as DurableObjectState,
    ),
    harness,
  };
}

function makeRequest(path: string, body: unknown): Request {
  return new Request(`https://proxy-trust-state${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("ProxyTrustState", () => {
  it("persists and answers known-agent checks via agent peer index", async () => {
    const { proxyTrustState, harness } = createProxyTrustState();

    const upsertResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.upsertPair, {
        initiatorAgentDid: "did:claw:agent:alice",
        responderAgentDid: "did:claw:agent:bob",
      }),
    );

    expect(upsertResponse.status).toBe(200);

    const knownAliceResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isAgentKnown, {
        agentDid: "did:claw:agent:alice",
      }),
    );
    expect(knownAliceResponse.status).toBe(200);
    expect((await knownAliceResponse.json()) as { known: boolean }).toEqual({
      known: true,
    });

    expect(harness.values.has("trust:agent-peers")).toBe(true);
  });

  it("confirms pairing ticket in one operation and persists trust", async () => {
    const { proxyTrustState } = createProxyTrustState();
    const ticketResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.createPairingTicket, {
        initiatorAgentDid: "did:claw:agent:alice",
        issuerProxyUrl: "https://proxy-a.example.com",
        ttlSeconds: 60,
        nowMs: 1_700_000_000_000,
      }),
    );
    const ticketBody = (await ticketResponse.json()) as { ticket: string };

    const confirmResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.confirmPairingTicket, {
        ticket: ticketBody.ticket,
        responderAgentDid: "did:claw:agent:bob",
        nowMs: 1_700_000_000_100,
      }),
    );

    expect(confirmResponse.status).toBe(200);
    expect(
      (await confirmResponse.json()) as {
        initiatorAgentDid: string;
        responderAgentDid: string;
        issuerProxyUrl: string;
      },
    ).toEqual({
      initiatorAgentDid: "did:claw:agent:alice",
      responderAgentDid: "did:claw:agent:bob",
      issuerProxyUrl: "https://proxy-a.example.com",
    });

    const pairCheckResponse = await proxyTrustState.fetch(
      makeRequest(TRUST_STORE_ROUTES.isPairAllowed, {
        initiatorAgentDid: "did:claw:agent:bob",
        responderAgentDid: "did:claw:agent:alice",
      }),
    );
    expect((await pairCheckResponse.json()) as { allowed: boolean }).toEqual({
      allowed: true,
    });
  });
});
