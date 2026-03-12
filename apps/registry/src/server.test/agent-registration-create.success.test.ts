import { encodeBase64url } from "@clawdentity/protocol";
import { generateEd25519Keypair, verifyAIT } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_FRAMEWORK,
  DEFAULT_AGENT_TTL_DAYS,
} from "../agent-registration.js";
import { createRegistryApp } from "../server.js";
import {
  createDefaultRegistrySigning,
  createFakeDb,
  createTestBindings,
  makeValidPatContext,
  requestRegistrationChallenge,
  signRegistrationChallenge,
} from "./helpers.js";

describe("POST /v1/agents", () => {
  it("creates an agent, defaults framework/ttl, and persists current_jti + expires_at", async () => {
    const { token, authRow } = await makeValidPatContext();
    const {
      database,
      agentInserts,
      agentAuthSessionInserts,
      agentAuthEventInserts,
    } = createFakeDb([authRow]);
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { response: challengeResponse, body: challengeBody } =
      await requestRegistrationChallenge({
        app: appInstance,
        token,
        publicKey: encodeBase64url(agentKeypair.publicKey),
        bindings: createTestBindings(database, signingEnv),
      });
    expect(challengeResponse.status).toBe(201);

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-01",
      secretKey: agentKeypair.secretKey,
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
          name: "agent-01",
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: {
        id: string;
        did: string;
        ownerDid: string;
        name: string;
        framework: string;
        publicKey: string;
        currentJti: string;
        ttlDays: number;
        status: string;
        expiresAt: string;
        createdAt: string;
        updatedAt: string;
      };
      ait: string;
      agentAuth: {
        tokenType: string;
        accessToken: string;
        accessExpiresAt: string;
        refreshToken: string;
        refreshExpiresAt: string;
      };
    };

    expect(body.agent.name).toBe("agent-01");
    expect(body.agent.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(body.agent.ttlDays).toBe(DEFAULT_AGENT_TTL_DAYS);
    expect(body.agent.publicKey).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(body.agent.status).toBe("active");
    expect(body.ait).toEqual(expect.any(String));
    expect(body.agentAuth.tokenType).toBe("Bearer");
    expect(body.agentAuth.accessToken.startsWith("clw_agt_")).toBe(true);
    expect(body.agentAuth.refreshToken.startsWith("clw_rft_")).toBe(true);
    expect(Date.parse(body.agentAuth.accessExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(Date.parse(body.agentAuth.refreshExpiresAt)).toBeGreaterThan(
      Date.now(),
    );

    expect(agentInserts).toHaveLength(1);
    const inserted = agentInserts[0];
    expect(inserted?.owner_id).toBe("human-1");
    expect(inserted?.name).toBe("agent-01");
    expect(inserted?.framework).toBe(DEFAULT_AGENT_FRAMEWORK);
    expect(inserted?.public_key).toBe(encodeBase64url(agentKeypair.publicKey));
    expect(inserted?.current_jti).toBe(body.agent.currentJti);
    expect(inserted?.expires_at).toBe(body.agent.expiresAt);
    expect(agentAuthSessionInserts).toHaveLength(1);
    expect(agentAuthSessionInserts[0]).toMatchObject({
      agent_id: body.agent.id,
      status: "active",
    });
    expect(agentAuthEventInserts).toHaveLength(1);
    expect(agentAuthEventInserts[0]).toMatchObject({
      agent_id: body.agent.id,
      event_type: "issued",
    });
  });

  it("returns verifiable AIT using published keyset", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);
    const { signingEnv } = await createDefaultRegistrySigning();
    const agentKeypair = await generateEd25519Keypair();
    const appInstance = createRegistryApp();

    const { response: challengeResponse, body: challengeBody } =
      await requestRegistrationChallenge({
        app: appInstance,
        token,
        publicKey: encodeBase64url(agentKeypair.publicKey),
        bindings: createTestBindings(database, signingEnv),
      });
    expect(challengeResponse.status).toBe(201);

    const challengeSignature = await signRegistrationChallenge({
      challengeId: challengeBody.challengeId,
      nonce: challengeBody.nonce,
      ownerDid: challengeBody.ownerDid,
      publicKey: encodeBase64url(agentKeypair.publicKey),
      name: "agent-registry-verify",
      framework: "openclaw",
      ttlDays: 10,
      secretKey: agentKeypair.secretKey,
    });

    const registerResponse = await appInstance.request(
      "/v1/agents",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "agent-registry-verify",
          framework: "openclaw",
          ttlDays: 10,
          publicKey: encodeBase64url(agentKeypair.publicKey),
          challengeId: challengeBody.challengeId,
          challengeSignature,
        }),
      },
      createTestBindings(database, signingEnv),
    );

    expect(registerResponse.status).toBe(201);
    const registerBody = (await registerResponse.json()) as {
      agent: {
        did: string;
        ownerDid: string;
        name: string;
        framework: string;
        publicKey: string;
        currentJti: string;
      };
      ait: string;
    };

    const keysResponse = await appInstance.request(
      "/.well-known/claw-keys.json",
      {},
      createTestBindings(database, signingEnv),
    );
    const keysBody = (await keysResponse.json()) as {
      keys: Array<{
        kid: string;
        alg: "EdDSA";
        crv: "Ed25519";
        x: string;
        status: "active" | "revoked";
      }>;
    };

    const claims = await verifyAIT({
      token: registerBody.ait,
      expectedIssuer: "https://dev.registry.clawdentity.com",
      registryKeys: keysBody.keys
        .filter((key) => key.status === "active")
        .map((key) => ({
          kid: key.kid,
          jwk: {
            kty: "OKP" as const,
            crv: key.crv,
            x: key.x,
          },
        })),
    });

    expect(claims.iss).toBe("https://dev.registry.clawdentity.com");
    expect(claims.sub).toBe(registerBody.agent.did);
    expect(claims.ownerDid).toBe(registerBody.agent.ownerDid);
    expect(claims.name).toBe(registerBody.agent.name);
    expect(claims.framework).toBe(registerBody.agent.framework);
    expect(claims.cnf.jwk.x).toBe(registerBody.agent.publicKey);
    expect(claims.jti).toBe(registerBody.agent.currentJti);
  });
});
