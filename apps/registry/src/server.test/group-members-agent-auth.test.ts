import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import {
  AGENT_AUTHORITY,
  buildSignedAgentGroupRequest,
} from "./helpers/group-agent-auth.js";
import { createFakeDb } from "./helpers.js";

describe("GET /v1/groups/:id/members", () => {
  it("supports agent-auth members list for creator-owner without member row", async () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const agentId = generateUlid(Date.now());
    const agentDid = makeAgentDid(AGENT_AUTHORITY, agentId);
    const aitJti = generateUlid(Date.now() + 1);
    const request = await buildSignedAgentGroupRequest({
      path: `/v1/groups/${groupId}/members`,
      agentDid,
      aitJti,
    });
    const { database } = createFakeDb(
      [],
      [
        {
          id: agentId,
          did: agentDid,
          ownerId: "human-1",
          name: "group-reader",
          framework: "openclaw",
          publicKey: "unused-in-this-test",
          status: "active",
          expiresAt: null,
          currentJti: aitJti,
        },
      ],
      {
        groupRows: [
          {
            id: groupId,
            name: "alpha squad",
            createdBy: "human-1",
            createdAt: "2026-03-01T00:00:00.000Z",
            updatedAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      },
    );

    const res = await createRegistryApp().request(
      `/v1/groups/${groupId}/members`,
      {
        method: "GET",
        headers: request.headers,
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
        REGISTRY_SIGNING_KEY: request.registrySigningKey,
        REGISTRY_SIGNING_KEYS: request.registrySigningKeys,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      group: { id: string };
      members: Array<{ agentDid: string }>;
    };
    expect(body.group.id).toBe(groupId);
    expect(Array.isArray(body.members)).toBe(true);
  });
});
