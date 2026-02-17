import {
  AGENT_AUTH_VALIDATE_PATH,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
  signAIT,
  signCRL,
  signHttpRequest,
} from "@clawdentity/sdk";
import { describe, expect, it, vi } from "vitest";
import { RELAY_RECIPIENT_AGENT_DID_HEADER } from "./agent-hook-route.js";
import type { AgentRelaySessionNamespace } from "./agent-relay-session.js";
import { parseProxyConfig } from "./config.js";
import { RELAY_CONNECT_PATH } from "./relay-connect-route.js";
import { createProxyApp } from "./server.js";

const REGISTRY_KID = "registry-active-kid";
const NOW_MS = Date.now();
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const ISSUER = "https://api.clawdentity.com";
const BODY_JSON = JSON.stringify({ message: "hello" });

type AuthHarnessOptions = {
  expired?: boolean;
  crlStaleBehavior?: "fail-open" | "fail-closed";
  fetchCrlFails?: boolean;
  fetchKeysFails?: boolean;
  allowCurrentAgent?: boolean;
  allowCurrentOwner?: boolean;
  revoked?: boolean;
  validateStatus?: number;
};

type AuthHarness = {
  app: ReturnType<typeof createProxyApp>;
  claims: Awaited<ReturnType<typeof buildAitClaims>>;
  createSignedHeaders: (input?: {
    body?: string;
    method?: "GET" | "POST";
    nonce?: string;
    pathWithQuery?: string;
    timestamp?: string;
    timestampSeconds?: number;
  }) => Promise<Record<string, string>>;
};

async function buildAitClaims(input: { agentPublicKeyX: string }): Promise<{
  iss: string;
  sub: string;
  ownerDid: string;
  name: string;
  framework: string;
  description: string;
  cnf: {
    jwk: {
      kty: "OKP";
      crv: "Ed25519";
      x: string;
    };
  };
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}> {
  return {
    iss: ISSUER,
    sub: makeAgentDid(generateUlid(NOW_MS + 10)),
    ownerDid: makeHumanDid(generateUlid(NOW_MS + 20)),
    name: "Proxy Agent",
    framework: "openclaw",
    description: "test agent",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: input.agentPublicKeyX,
      },
    },
    iat: NOW_SECONDS - 10,
    nbf: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 600,
    jti: generateUlid(NOW_MS + 30),
  };
}

function resolveRequestUrl(requestInput: unknown): string {
  if (typeof requestInput === "string") {
    return requestInput;
  }
  if (requestInput instanceof URL) {
    return requestInput.toString();
  }
  if (
    typeof requestInput === "object" &&
    requestInput !== null &&
    "url" in requestInput &&
    typeof (requestInput as { url?: unknown }).url === "string"
  ) {
    return (requestInput as { url: string }).url;
  }

  return "";
}

function createFetchMock(input: {
  crlToken: string;
  fetchCrlFails?: boolean;
  fetchKeysFails?: boolean;
  registryPublicKeyX: string;
  validateStatus?: number;
}) {
  return vi.fn(async (requestInput: unknown): Promise<Response> => {
    const url = resolveRequestUrl(requestInput);

    if (url.endsWith("/.well-known/claw-keys.json")) {
      if (input.fetchKeysFails) {
        throw new Error("keys unavailable");
      }

      return new Response(
        JSON.stringify({
          keys: [
            {
              kid: REGISTRY_KID,
              alg: "EdDSA",
              crv: "Ed25519",
              x: input.registryPublicKeyX,
              status: "active",
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/v1/crl")) {
      if (input.fetchCrlFails) {
        throw new Error("crl unavailable");
      }

      return new Response(
        JSON.stringify({
          crl: input.crlToken,
        }),
        { status: 200 },
      );
    }

    if (url.endsWith(AGENT_AUTH_VALIDATE_PATH)) {
      const status = input.validateStatus ?? 204;
      return new Response(status === 204 ? null : "", { status });
    }

    return new Response("not found", { status: 404 });
  });
}

async function createAuthHarness(
  options: AuthHarnessOptions = {},
): Promise<AuthHarness> {
  const registryKeypair = await generateEd25519Keypair();
  const agentKeypair = await generateEd25519Keypair();
  const encodedRegistry = encodeEd25519KeypairBase64url(registryKeypair);
  const encodedAgent = encodeEd25519KeypairBase64url(agentKeypair);
  const claims = await buildAitClaims({
    agentPublicKeyX: encodedAgent.publicKey,
  });
  if (options.expired) {
    claims.exp = NOW_SECONDS - 1;
  }

  const ait = await signAIT({
    claims,
    signerKid: REGISTRY_KID,
    signerKeypair: registryKeypair,
  });

  const revocationJti = options.revoked
    ? claims.jti
    : generateUlid(NOW_MS + 40);
  const crl = await signCRL({
    claims: {
      iss: ISSUER,
      jti: generateUlid(NOW_MS + 50),
      iat: NOW_SECONDS - 10,
      exp: NOW_SECONDS + 600,
      revocations: [
        {
          jti: revocationJti,
          agentDid: claims.sub,
          revokedAt: NOW_SECONDS - 5,
          reason: "manual revoke",
        },
      ],
    },
    signerKid: REGISTRY_KID,
    signerKeypair: registryKeypair,
  });

  const fetchMock = createFetchMock({
    crlToken: crl,
    fetchCrlFails: options.fetchCrlFails,
    fetchKeysFails: options.fetchKeysFails,
    registryPublicKeyX: encodedRegistry.publicKey,
    validateStatus: options.validateStatus,
  });

  const allowListAgents =
    options.allowCurrentAgent === false ? [] : [claims.sub];
  const allowListOwners = options.allowCurrentOwner ? [claims.ownerDid] : [];
  const relaySession = {
    fetch: vi.fn(async (request: Request) => {
      if (request.method === "POST") {
        return Response.json(
          {
            delivered: true,
            connectedSockets: 1,
          },
          { status: 202 },
        );
      }

      return new Response(null, { status: 204 });
    }),
  };
  const relayNamespace = {
    idFromName: vi.fn((_name: string) => ({}) as DurableObjectId),
    get: vi.fn((_id: DurableObjectId) => relaySession),
  } satisfies AgentRelaySessionNamespace;

  const app = createProxyApp({
    config: parseProxyConfig({
      ...(allowListAgents.length > 0
        ? { ALLOWLIST_AGENTS: allowListAgents.join(",") }
        : {}),
      ...(allowListOwners.length > 0
        ? { ALLOWLIST_OWNERS: allowListOwners.join(",") }
        : {}),
      ...(options.crlStaleBehavior
        ? { CRL_STALE_BEHAVIOR: options.crlStaleBehavior }
        : {}),
    }),
    auth: {
      fetchImpl: fetchMock as typeof fetch,
      clock: () => NOW_MS,
    },
    hooks: {
      resolveSessionNamespace: () => relayNamespace,
      now: () => new Date(NOW_MS),
    },
    relay: {
      resolveSessionNamespace: () => relayNamespace,
    },
    registerRoutes: (nextApp) => {
      nextApp.post("/protected", (c) => {
        const auth = c.get("auth");
        return c.json({
          ok: true,
          auth,
        });
      });
    },
  });

  return {
    app,
    claims,
    createSignedHeaders: async (input = {}) => {
      const method = input.method ?? "POST";
      const body = input.body ?? (method === "GET" ? "" : BODY_JSON);
      const nonce = input.nonce ?? "nonce-1";
      const pathWithQuery = input.pathWithQuery ?? "/protected";
      const timestamp =
        input.timestamp ?? String(input.timestampSeconds ?? NOW_SECONDS);

      const signed = await signHttpRequest({
        method,
        pathWithQuery,
        timestamp,
        nonce,
        body: new TextEncoder().encode(body),
        secretKey: agentKeypair.secretKey,
      });

      return {
        authorization: `Claw ${ait}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        ...signed.headers,
      };
    },
  };
}

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

  it("returns 403 when a verified caller is not allowlisted by agent DID", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-not-allowlisted",
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

  it("returns 403 when only owner DID is allowlisted", async () => {
    const harness = await createAuthHarness({
      allowCurrentAgent: false,
      allowCurrentOwner: true,
    });
    const headers = await harness.createSignedHeaders({
      nonce: "nonce-owner-only-allowlisted",
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

  it("refreshes keyset and accepts valid AIT after registry key rotation", async () => {
    const oldKid = "registry-old-kid";
    const newKid = "registry-new-kid";
    const oldRegistryKeypair = await generateEd25519Keypair();
    const newRegistryKeypair = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const encodedOldRegistry =
      encodeEd25519KeypairBase64url(oldRegistryKeypair);
    const encodedNewRegistry =
      encodeEd25519KeypairBase64url(newRegistryKeypair);
    const encodedAgent = encodeEd25519KeypairBase64url(agentKeypair);

    const claims = await buildAitClaims({
      agentPublicKeyX: encodedAgent.publicKey,
    });
    const ait = await signAIT({
      claims,
      signerKid: newKid,
      signerKeypair: newRegistryKeypair,
    });
    const crl = await signCRL({
      claims: {
        iss: ISSUER,
        jti: generateUlid(NOW_MS + 70),
        iat: NOW_SECONDS - 10,
        exp: NOW_SECONDS + 600,
        revocations: [
          {
            jti: generateUlid(NOW_MS + 80),
            agentDid: claims.sub,
            revokedAt: NOW_SECONDS - 5,
            reason: "manual revoke",
          },
        ],
      },
      signerKid: newKid,
      signerKeypair: newRegistryKeypair,
    });

    let keyFetchCount = 0;
    const fetchMock = vi.fn(
      async (requestInput: unknown): Promise<Response> => {
        const url = resolveRequestUrl(requestInput);
        if (url.endsWith("/.well-known/claw-keys.json")) {
          keyFetchCount += 1;
          const key =
            keyFetchCount === 1
              ? {
                  kid: oldKid,
                  alg: "EdDSA",
                  crv: "Ed25519",
                  x: encodedOldRegistry.publicKey,
                  status: "active",
                }
              : {
                  kid: newKid,
                  alg: "EdDSA",
                  crv: "Ed25519",
                  x: encodedNewRegistry.publicKey,
                  status: "active",
                };
          return new Response(
            JSON.stringify({
              keys: [key],
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/crl")) {
          return new Response(
            JSON.stringify({
              crl,
            }),
            { status: 200 },
          );
        }

        return new Response("not found", { status: 404 });
      },
    );

    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "openclaw-hook-token",
        ALLOWLIST_AGENTS: claims.sub,
      }),
      auth: {
        fetchImpl: fetchMock as typeof fetch,
        clock: () => NOW_MS,
      },
      registerRoutes: (nextApp) => {
        nextApp.post("/protected", (c) => c.json({ ok: true }));
      },
    });

    const signed = await signHttpRequest({
      method: "POST",
      pathWithQuery: "/protected",
      timestamp: String(NOW_SECONDS),
      nonce: "nonce-rotation",
      body: new TextEncoder().encode(BODY_JSON),
      secretKey: agentKeypair.secretKey,
    });
    const response = await app.request("/protected", {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signed.headers,
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(200);
    expect(keyFetchCount).toBe(2);
  });

  it("refreshes keyset and verifies CRL after registry CRL key rotation", async () => {
    const oldKid = "registry-old-kid";
    const newKid = "registry-new-kid";
    const oldRegistryKeypair = await generateEd25519Keypair();
    const newRegistryKeypair = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const encodedOldRegistry =
      encodeEd25519KeypairBase64url(oldRegistryKeypair);
    const encodedNewRegistry =
      encodeEd25519KeypairBase64url(newRegistryKeypair);
    const encodedAgent = encodeEd25519KeypairBase64url(agentKeypair);

    const claims = await buildAitClaims({
      agentPublicKeyX: encodedAgent.publicKey,
    });
    const ait = await signAIT({
      claims,
      signerKid: oldKid,
      signerKeypair: oldRegistryKeypair,
    });
    const crl = await signCRL({
      claims: {
        iss: ISSUER,
        jti: generateUlid(NOW_MS + 90),
        iat: NOW_SECONDS - 10,
        exp: NOW_SECONDS + 600,
        revocations: [
          {
            jti: generateUlid(NOW_MS + 100),
            agentDid: claims.sub,
            revokedAt: NOW_SECONDS - 5,
            reason: "manual revoke",
          },
        ],
      },
      signerKid: newKid,
      signerKeypair: newRegistryKeypair,
    });

    let keyFetchCount = 0;
    const fetchMock = vi.fn(
      async (requestInput: unknown): Promise<Response> => {
        const url = resolveRequestUrl(requestInput);
        if (url.endsWith("/.well-known/claw-keys.json")) {
          keyFetchCount += 1;
          const key =
            keyFetchCount === 1
              ? {
                  kid: oldKid,
                  alg: "EdDSA",
                  crv: "Ed25519",
                  x: encodedOldRegistry.publicKey,
                  status: "active",
                }
              : {
                  kid: newKid,
                  alg: "EdDSA",
                  crv: "Ed25519",
                  x: encodedNewRegistry.publicKey,
                  status: "active",
                };
          return new Response(
            JSON.stringify({
              keys: [key],
            }),
            { status: 200 },
          );
        }

        if (url.endsWith("/v1/crl")) {
          return new Response(
            JSON.stringify({
              crl,
            }),
            { status: 200 },
          );
        }

        return new Response("not found", { status: 404 });
      },
    );

    const app = createProxyApp({
      config: parseProxyConfig({
        OPENCLAW_HOOK_TOKEN: "openclaw-hook-token",
        ALLOWLIST_AGENTS: claims.sub,
      }),
      auth: {
        fetchImpl: fetchMock as typeof fetch,
        clock: () => NOW_MS,
      },
      registerRoutes: (nextApp) => {
        nextApp.post("/protected", (c) => c.json({ ok: true }));
      },
    });

    const signed = await signHttpRequest({
      method: "POST",
      pathWithQuery: "/protected",
      timestamp: String(NOW_SECONDS),
      nonce: "nonce-crl-rotation",
      body: new TextEncoder().encode(BODY_JSON),
      secretKey: agentKeypair.secretKey,
    });
    const response = await app.request("/protected", {
      method: "POST",
      headers: {
        authorization: `Claw ${ait}`,
        "content-type": "application/json",
        ...signed.headers,
      },
      body: BODY_JSON,
    });

    expect(response.status).toBe(200);
    expect(keyFetchCount).toBe(2);
  });

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
