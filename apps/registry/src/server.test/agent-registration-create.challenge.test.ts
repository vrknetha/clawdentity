import { encodeBase64url, generateUlid } from "@clawdentity/protocol";
import {
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import {
  createDefaultRegistrySigning,
  createFakeDb,
  createTestBindings,
  makeValidPatContext,
  signRegistrationChallenge,
} from "./helpers.js";

describe("POST /v1/agents", () => {
  it("returns 400 when registration challenge is missing", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const challengeSignature = encodeEd25519SignatureBase64url(
      Uint8Array.from({ length: 64 }, (_, index) => index + 1),
    );

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-missing-challenge",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: generateUlid(1700000000000),
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_NOT_FOUND");
  });

  it("returns 400 when challenge signature is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const challengeId = generateUlid(1700000010000);
    const challengeNonce = encodeBase64url(
      Uint8Array.from({ length: 24 }, (_, index) => index + 3),
    );
    const { database } = createFakeDb([authRow], [], {
      registrationChallengeRows: [
        {
          id: challengeId,
          ownerId: "human-1",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          nonce: challengeNonce,
          status: "pending",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          usedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const invalidSignature = await signRegistrationChallenge({
      challengeId,
      nonce: challengeNonce,
      ownerDid: authRow.humanDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "wrong-name",
      secretKey: agentKeypair.secretKey,
    });

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-proof-invalid",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId,
          challengeSignature: invalidSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_PROOF_INVALID");
  });

  it("returns 400 when challenge has already been used", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const challengeId = generateUlid(1700000011000);
    const challengeNonce = encodeBase64url(
      Uint8Array.from({ length: 24 }, (_, index) => index + 5),
    );
    const { database } = createFakeDb([authRow], [], {
      registrationChallengeRows: [
        {
          id: challengeId,
          ownerId: "human-1",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          nonce: challengeNonce,
          status: "used",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          usedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const signature = await signRegistrationChallenge({
      challengeId,
      nonce: challengeNonce,
      ownerDid: authRow.humanDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-challenge-replayed",
      secretKey: agentKeypair.secretKey,
    });

    const res = await createRegistryApp().request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-challenge-replayed",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId,
          challengeSignature: signature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_REPLAYED");
  });
});
