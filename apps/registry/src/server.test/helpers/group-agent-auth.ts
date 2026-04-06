import {
  encodeBase64url,
  generateUlid,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  generateEd25519Keypair,
  signAIT,
  signHttpRequest,
} from "@clawdentity/sdk";

export const AGENT_AUTHORITY = "127.0.0.1";

export async function buildSignedAgentGroupRequest(options: {
  method?: "GET" | "POST";
  path: string;
  agentDid: string;
  aitJti: string;
  body?: Record<string, unknown>;
}) {
  const signer = await generateEd25519Keypair();
  const agentKeypair = await generateEd25519Keypair();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = String(nowSeconds);
  const nonce = `nonce-${options.method ?? "GET"}-${Date.now()}`;
  const bodyJson = options.body ? JSON.stringify(options.body) : "";
  const bodyBytes = new TextEncoder().encode(bodyJson);
  const ait = await signAIT({
    claims: {
      iss: "http://127.0.0.1:8788",
      sub: options.agentDid,
      ownerDid: makeHumanDid(AGENT_AUTHORITY, generateUlid(Date.now() + 10)),
      name: "group-reader",
      framework: "openclaw",
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: encodeBase64url(agentKeypair.publicKey),
        },
      },
      iat: nowSeconds - 10,
      nbf: nowSeconds - 10,
      exp: nowSeconds + 3600,
      jti: options.aitJti,
    },
    signerKid: "reg-key-1",
    signerKeypair: signer,
  });
  const signed = await signHttpRequest({
    method: options.method ?? "GET",
    pathWithQuery: options.path,
    timestamp,
    nonce,
    body: bodyBytes,
    secretKey: agentKeypair.secretKey,
  });

  return {
    body: bodyJson,
    headers: {
      authorization: `Claw ${ait}`,
      ...(bodyJson.length > 0 ? { "content-type": "application/json" } : {}),
      ...signed.headers,
    },
    registrySigningKey: encodeBase64url(signer.secretKey),
    registrySigningKeys: JSON.stringify([
      {
        kid: "reg-key-1",
        alg: "EdDSA",
        crv: "Ed25519",
        x: encodeBase64url(signer.publicKey),
        status: "active",
      },
    ]),
  };
}
