import { AGENT_AUTH_VALIDATE_PATH, generateUlid } from "@clawdentity/protocol";
import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
  signAIT,
  signCRL,
  signHttpRequest,
} from "@clawdentity/sdk";
import { buildTestAitClaims } from "@clawdentity/sdk/testing";
import { vi } from "vitest";
import type { AgentRelaySessionNamespace } from "../agent-relay-session.js";
import type { ProxyNonceCache } from "../auth-middleware.js";
import { parseProxyConfig } from "../config.js";
import { createInMemoryProxyTrustStore } from "../proxy-trust-store.js";
import { createProxyApp } from "../server.js";

export const REGISTRY_KID = "registry-active-kid";
export const NOW_MS = Date.now();
export const NOW_SECONDS = Math.floor(NOW_MS / 1000);
export const ISSUER = "https://registry.clawdentity.com";
export const BODY_JSON = JSON.stringify({ message: "hello" });
export const KNOWN_PEER_DID =
  "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT8";

type SignedHeadersInput = {
  body?: string;
  method?: "GET" | "POST";
  nonce?: string;
  pathWithQuery?: string;
  timestamp?: string;
  timestampSeconds?: number;
};

export type AuthHarnessOptions = {
  expired?: boolean;
  crlStaleBehavior?: "fail-open" | "fail-closed";
  fetchCrlFails?: boolean;
  fetchKeysFails?: boolean;
  allowCurrentAgent?: boolean;
  revoked?: boolean;
  validateStatus?: number;
  nonceCache?: ProxyNonceCache;
};

export type AuthHarness = {
  app: ReturnType<typeof createProxyApp>;
  claims: ReturnType<typeof buildTestAitClaims>;
  createApp: (input?: {
    nonceCache?: ProxyNonceCache;
  }) => ReturnType<typeof createProxyApp>;
  createSignedHeaders: (
    input?: SignedHeadersInput,
  ) => Promise<Record<string, string>>;
};

export function resolveRequestUrl(requestInput: unknown): string {
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

export async function createAuthHarness(
  options: AuthHarnessOptions = {},
): Promise<AuthHarness> {
  const registryKeypair = await generateEd25519Keypair();
  const agentKeypair = await generateEd25519Keypair();
  const encodedRegistry = encodeEd25519KeypairBase64url(registryKeypair);
  const encodedAgent = encodeEd25519KeypairBase64url(agentKeypair);
  const claims = buildTestAitClaims({
    publicKeyX: encodedAgent.publicKey,
    issuer: ISSUER,
    nowSeconds: NOW_SECONDS - 10,
    ttlSeconds: 610,
    nbfSkewSeconds: 0,
    seedMs: NOW_MS,
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

  const trustStore = createInMemoryProxyTrustStore();
  if (options.allowCurrentAgent !== false) {
    await trustStore.upsertPair({
      initiatorAgentDid: claims.sub,
      responderAgentDid: KNOWN_PEER_DID,
    });
  }

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

  const config = parseProxyConfig({
    REGISTRY_URL: ISSUER,
    ...(options.crlStaleBehavior
      ? { CRL_STALE_BEHAVIOR: options.crlStaleBehavior }
      : {}),
  });
  const createApp = (input?: { nonceCache?: ProxyNonceCache }) =>
    createProxyApp({
      config,
      trustStore,
      auth: {
        fetchImpl: fetchMock as typeof fetch,
        clock: () => NOW_MS,
        nonceCache: input?.nonceCache ?? options.nonceCache,
      },
      hooks: {
        resolveSessionNamespace: () => relayNamespace,
        now: () => new Date(NOW_MS).toISOString(),
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
  const app = createApp();

  return {
    app,
    claims,
    createApp,
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
