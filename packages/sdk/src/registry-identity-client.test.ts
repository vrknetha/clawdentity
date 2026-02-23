import { makeAgentDid, makeHumanDid } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "./exceptions.js";
import {
  createRegistryIdentityClient,
  INTERNAL_SERVICE_ID_HEADER,
  INTERNAL_SERVICE_SECRET_HEADER,
} from "./registry-identity-client.js";

const AUTHORITY = "registry.clawdentity.com";
const OWNER_DID = makeHumanDid(AUTHORITY, "01HF7YAT31JZHSMW1CG6Q6MHB7");
const AGENT_DID = makeAgentDid(AUTHORITY, "01HF7YAT31JZHSMW1CG6Q6MHB7");

describe("registry identity client", () => {
  it("checks ownership with service credential headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        { ownsAgent: true, agentStatus: "active" },
        { status: 200 },
      ),
    );
    const client = createRegistryIdentityClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      registryUrl: "https://registry.clawdentity.com",
      serviceId: "01JTESTSERVICE1234567890AB",
      serviceSecret: "clw_srv_secret",
    });

    const result = await client.checkAgentOwnership({
      ownerDid: OWNER_DID,
      agentDid: AGENT_DID,
    });

    expect(result).toEqual({
      ownsAgent: true,
      agentStatus: "active",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get(INTERNAL_SERVICE_ID_HEADER)).toBe(
      "01JTESTSERVICE1234567890AB",
    );
    expect(headers.get(INTERNAL_SERVICE_SECRET_HEADER)).toBe("clw_srv_secret");
  });

  it("maps unauthorized responses to service-auth errors", async () => {
    const client = createRegistryIdentityClient({
      fetchImpl: (async () =>
        Response.json(
          {
            error: {
              code: "INTERNAL_SERVICE_UNAUTHORIZED",
              message: "service secret is invalid",
            },
          },
          { status: 401 },
        )) as typeof fetch,
      registryUrl: "https://registry.clawdentity.com",
      serviceId: "svc-proxy",
      serviceSecret: "bad-secret",
    });

    await expect(
      client.checkAgentOwnership({
        ownerDid: OWNER_DID,
        agentDid: AGENT_DID,
      }),
    ).rejects.toMatchObject({
      code: "IDENTITY_SERVICE_UNAUTHORIZED",
      status: 503,
    } satisfies Partial<AppError>);
  });

  it("maps network failures to unavailable errors", async () => {
    const client = createRegistryIdentityClient({
      fetchImpl: (async () => {
        throw new Error("network error");
      }) as typeof fetch,
      registryUrl: "https://registry.clawdentity.com",
      serviceId: "svc-proxy",
      serviceSecret: "secret",
    });

    await expect(
      client.checkAgentOwnership({
        ownerDid: OWNER_DID,
        agentDid: AGENT_DID,
      }),
    ).rejects.toMatchObject({
      code: "IDENTITY_SERVICE_UNAVAILABLE",
      status: 503,
    } satisfies Partial<AppError>);
  });

  it("rejects invalid ownership response payloads", async () => {
    const client = createRegistryIdentityClient({
      fetchImpl: (async () =>
        Response.json(
          { ownsAgent: "yes", agentStatus: "active" },
          { status: 200 },
        )) as typeof fetch,
      registryUrl: "https://registry.clawdentity.com",
      serviceId: "svc-proxy",
      serviceSecret: "secret",
    });

    await expect(
      client.checkAgentOwnership({
        ownerDid: OWNER_DID,
        agentDid: AGENT_DID,
      }),
    ).rejects.toMatchObject({
      code: "IDENTITY_SERVICE_INVALID_RESPONSE",
      status: 503,
    } satisfies Partial<AppError>);
  });
});
