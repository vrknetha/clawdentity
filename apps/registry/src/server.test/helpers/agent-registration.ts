import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  encodeBase64url,
} from "@clawdentity/protocol";
import { generateEd25519Keypair } from "@clawdentity/sdk";

export type RegistrationChallengeBody = {
  challengeId: string;
  nonce: string;
  ownerDid: string;
};

export type RegistrySigningEnv = {
  REGISTRY_SIGNING_KEY: string;
  REGISTRY_SIGNING_KEYS: string;
};

export type Ed25519Keypair = Awaited<ReturnType<typeof generateEd25519Keypair>>;

export function createRegistrySigningEnv(input: {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  kid?: string;
}): RegistrySigningEnv {
  return {
    REGISTRY_SIGNING_KEY: encodeBase64url(input.secretKey),
    REGISTRY_SIGNING_KEYS: JSON.stringify([
      {
        kid: input.kid ?? "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(input.publicKey),
        status: "active",
      },
    ]),
  };
}

export async function createDefaultRegistrySigning(input?: {
  kid?: string;
}): Promise<{
  signer: Ed25519Keypair;
  signingEnv: RegistrySigningEnv;
}> {
  const signer = await generateEd25519Keypair();
  return {
    signer,
    signingEnv: createRegistrySigningEnv({
      publicKey: signer.publicKey,
      secretKey: signer.secretKey,
      kid: input?.kid,
    }),
  };
}

export function createTestBindings(
  database: D1Database,
  extra: Record<string, unknown> = {},
): { DB: D1Database; ENVIRONMENT: "test" } & Record<string, unknown> {
  return {
    DB: database,
    ENVIRONMENT: "test",
    ...extra,
  };
}

export function createProductionBindings(
  database: D1Database,
  extra: Record<string, unknown> = {},
): {
  DB: D1Database;
  ENVIRONMENT: "production";
  PROXY_URL: string;
  REGISTRY_ISSUER_URL: string;
  EVENT_BUS_BACKEND: "memory";
  BOOTSTRAP_SECRET: string;
} & Record<string, unknown> {
  return {
    DB: database,
    ENVIRONMENT: "production",
    PROXY_URL: "https://proxy.clawdentity.com",
    REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
    EVENT_BUS_BACKEND: "memory",
    BOOTSTRAP_SECRET: "bootstrap-secret",
    ...extra,
  };
}

export async function requestRegistrationChallenge(input: {
  app: unknown;
  token: string;
  publicKey: string;
  bindings: unknown;
}): Promise<{
  response: Response;
  body: RegistrationChallengeBody;
}> {
  const request = (
    input.app as {
      request: (
        path: URL | RequestInfo,
        requestInit?: RequestInit,
        bindings?: unknown,
      ) => Response | Promise<Response>;
    }
  ).request;

  const response = await Promise.resolve(
    request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: input.publicKey,
        }),
      },
      input.bindings,
    ),
  );

  const body = (await response.json()) as RegistrationChallengeBody;
  return { response, body };
}
