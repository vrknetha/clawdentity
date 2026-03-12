import {
  AGENT_AUTH_REFRESH_PATH,
  canonicalizeAgentRegistrationProof,
} from "@clawdentity/protocol";
import {
  encodeEd25519SignatureBase64url,
  signEd25519,
  signHttpRequest,
} from "@clawdentity/sdk";

export async function signRegistrationChallenge(options: {
  challengeId: string;
  nonce: string;
  ownerDid: string;
  publicKey: string;
  name: string;
  secretKey: Uint8Array;
  framework?: string;
  ttlDays?: number;
}): Promise<string> {
  const canonical = canonicalizeAgentRegistrationProof({
    challengeId: options.challengeId,
    nonce: options.nonce,
    ownerDid: options.ownerDid,
    publicKey: options.publicKey,
    name: options.name,
    framework: options.framework,
    ttlDays: options.ttlDays,
  });
  const signature = await signEd25519(
    new TextEncoder().encode(canonical),
    options.secretKey,
  );
  return encodeEd25519SignatureBase64url(signature);
}

export async function createSignedAgentRefreshRequest(options: {
  ait: string;
  secretKey: Uint8Array;
  refreshToken: string;
  timestamp?: string;
  nonce?: string;
}): Promise<{
  body: string;
  headers: Record<string, string>;
}> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? "nonce-agent-refresh";
  const body = JSON.stringify({
    refreshToken: options.refreshToken,
  });
  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: AGENT_AUTH_REFRESH_PATH,
    timestamp,
    nonce,
    body: new TextEncoder().encode(body),
    secretKey: options.secretKey,
  });

  return {
    body,
    headers: {
      authorization: `Claw ${options.ait}`,
      "content-type": "application/json",
      ...signed.headers,
    },
  };
}
