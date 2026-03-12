import { encodeBase64url } from "@clawdentity/protocol";
import { generateEd25519Keypair } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import {
  createDefaultRegistrySigning,
  createFakeDb,
  createRegistrySigningEnv,
  createTestBindings,
  makeValidPatContext,
  requestRegistrationChallenge,
  signRegistrationChallenge,
} from "./helpers.js";

describe("POST /v1/agents", () => {
  it("returns 500 when signer secret does not match any active published key", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const { signer } = await createDefaultRegistrySigning();
    const wrongPublishedKey = await generateEd25519Keypair();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { response: challengeResponse, body: challengeBody } =
      await requestRegistrationChallenge({
        app: appInstance,
        token,
        publicKey: encodeBase64url(agentKeypair.publicKey),
        bindings: createTestBindings(database),
      });
    expect(challengeResponse.status).toBe(201);

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-signer-mismatch",
      secretKey: agentKeypair.secretKey,
    });

    const mismatchedSigningEnv = createRegistrySigningEnv({
      kid: "reg-key-2",
      publicKey: wrongPublishedKey.publicKey,
      secretKey: signer.secretKey,
    });

    const res = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-signer-mismatch",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, mismatchedSigningEnv),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
    expect(body.error.details?.fieldErrors).toMatchObject({
      REGISTRY_SIGNING_KEYS: expect.any(Array),
    });
  });
});
