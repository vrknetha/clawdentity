import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  encodeBase64url,
} from "@clawdentity/protocol";
import { generateEd25519Keypair } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

describe(`POST ${AGENT_REGISTRATION_CHALLENGE_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
        }),
      },
      { DB: {} as D1Database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 400 when payload is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: "not-base64url",
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, unknown> };
      };
    };
    expect(body.error.code).toBe("AGENT_REGISTRATION_CHALLENGE_INVALID");
    expect(body.error.details?.fieldErrors).toMatchObject({
      publicKey: expect.any(Array),
    });
  });

  it("creates and persists challenge for authenticated owner", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, agentRegistrationChallengeInserts } = createFakeDb([
      authRow,
    ]);
    const agentKeypair = await generateEd25519Keypair();

    const res = await createRegistryApp().request(
      AGENT_REGISTRATION_CHALLENGE_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: encodeBase64url(agentKeypair.publicKey),
        }),
      },
      { DB: database, ENVIRONMENT: "test" },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      challengeId: string;
      nonce: string;
      ownerDid: string;
      expiresAt: string;
      algorithm: string;
      messageTemplate: string;
    };
    expect(body.challengeId).toEqual(expect.any(String));
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.ownerDid).toBe(authRow.humanDid);
    expect(body.algorithm).toBe("Ed25519");
    expect(body.messageTemplate).toContain("challengeId:{challengeId}");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    expect(agentRegistrationChallengeInserts).toHaveLength(1);
    expect(agentRegistrationChallengeInserts[0]).toMatchObject({
      id: body.challengeId,
      owner_id: "human-1",
      public_key: encodeBase64url(agentKeypair.publicKey),
      nonce: body.nonce,
      status: "pending",
      used_at: null,
    });
  });
});
