import { encodeBase64url } from "@clawdentity/protocol";
import { generateEd25519Keypair } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import {
  createDefaultRegistrySigning,
  createFakeDb,
  createTestBindings,
  makeValidPatContext,
  requestRegistrationChallenge,
  signRegistrationChallenge,
} from "./helpers.js";

describe("POST /v1/agents registration limits", () => {
  it("rejects a second agent for a starter-pass human with limit 1", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb(
      [
        {
          ...authRow,
          humanRole: "user",
          humanOnboardingSource: "github_starter_pass",
          humanAgentLimit: 1,
        },
      ],
      [
        {
          id: "01HF7YAT31JZHSMW1CG6Q6MHQ1",
          did: "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHQ1",
          ownerId: authRow.humanId,
          name: "existing-agent",
          framework: "openclaw",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          status: "active",
          expiresAt: "2099-01-01T00:00:00.000Z",
          currentJti: "jti-existing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { body: challengeBody } = await requestRegistrationChallenge({
      app: appInstance,
      token,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      bindings: createTestBindings(database, signingEnv),
    });

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "second-agent",
      secretKey: agentKeypair.secretKey,
    });

    const response = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "second-agent",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_LIMIT_REACHED");
  });

  it("allows more than one agent for invite/admin humans", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentInserts } = createFakeDb(
      [
        {
          ...authRow,
          humanRole: "user",
          humanOnboardingSource: "invite",
          humanAgentLimit: null,
        },
      ],
      [
        {
          id: "01HF7YAT31JZHSMW1CG6Q6MHQ2",
          did: "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHQ2",
          ownerId: authRow.humanId,
          name: "existing-agent",
          framework: "openclaw",
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          status: "active",
          expiresAt: "2099-01-01T00:00:00.000Z",
          currentJti: "jti-existing",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { body: challengeBody } = await requestRegistrationChallenge({
      app: appInstance,
      token,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      bindings: createTestBindings(database, signingEnv),
    });

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "second-agent",
      secretKey: agentKeypair.secretKey,
    });

    const response = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "second-agent",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(response.status).toBe(201);
    expect(agentInserts).toHaveLength(1);
  });

  it("enforces the limit inside the guarded registration mutation", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, registrationChallengeRows } = createFakeDb(
      [
        {
          ...authRow,
          humanRole: "user",
          humanOnboardingSource: "github_starter_pass",
          humanAgentLimit: 1,
        },
      ],
      [],
      {
        failBeginTransaction: true,
        beforeFirstAgentRegistrationChallengeUpdate(agentRows) {
          agentRows.push({
            id: "01HF7YAT31JZHSMW1CG6Q6MHQ9",
            did: "did:cdi:127.0.0.1:agent:01HF7YAT31JZHSMW1CG6Q6MHQ9",
            ownerId: authRow.humanId,
            name: "raced-agent",
            framework: "openclaw",
            publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            status: "active",
            expiresAt: "2099-01-01T00:00:00.000Z",
            currentJti: "jti-raced",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
        },
      },
    );
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { body: challengeBody } = await requestRegistrationChallenge({
      app: appInstance,
      token,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      bindings: createTestBindings(database, signingEnv),
    });

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "second-agent",
      secretKey: agentKeypair.secretKey,
    });

    const response = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "second-agent",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AGENT_REGISTRATION_LIMIT_REACHED");
    expect(registrationChallengeRows[0]?.status).toBe("pending");
    expect(registrationChallengeRows[0]?.usedAt).toBeNull();
  });
});
