import { describe, expect, it, vi } from "vitest";
import {
  type AgentAuthBundle,
  executeWithAgentAuthRefreshRetry,
  refreshAgentAuthWithClawProof,
} from "./agent-auth-client.js";
import { AppError } from "./exceptions.js";

const STALE_AUTH: AgentAuthBundle = {
  tokenType: "Bearer",
  accessToken: "clw_agt_old",
  accessExpiresAt: "2030-01-01T00:00:00.000Z",
  refreshToken: "clw_rft_old",
  refreshExpiresAt: "2030-02-01T00:00:00.000Z",
};

const FRESH_AUTH: AgentAuthBundle = {
  tokenType: "Bearer",
  accessToken: "clw_agt_new",
  accessExpiresAt: "2030-03-01T00:00:00.000Z",
  refreshToken: "clw_rft_new",
  refreshExpiresAt: "2030-04-01T00:00:00.000Z",
};

describe("agent auth client", () => {
  it("refreshes auth with claw proof", async () => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://registry.example.com/v1/agents/auth/refresh",
      );
      return new Response(
        JSON.stringify({
          agentAuth: FRESH_AUTH,
        }),
        { status: 200 },
      );
    });

    const result = await refreshAgentAuthWithClawProof({
      registryUrl: "https://registry.example.com",
      ait: "mock.ait.jwt",
      secretKey: new Uint8Array(32).fill(1),
      refreshToken: STALE_AUTH.refreshToken,
      fetchImpl: fetchMock as typeof fetch,
      nowMs: () => 1_700_000_000_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Claw mock.ait.jwt");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-claw-timestamp")).toBe("1700000000");
    expect(result).toEqual(FRESH_AUTH);
  });

  it("maps refresh 401 responses to unauthorized app errors", async () => {
    await expect(
      refreshAgentAuthWithClawProof({
        registryUrl: "https://registry.example.com",
        ait: "mock.ait.jwt",
        secretKey: new Uint8Array(32).fill(1),
        refreshToken: STALE_AUTH.refreshToken,
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: "AGENT_AUTH_REFRESH_EXPIRED",
                  message: "Agent auth refresh token is expired",
                },
              }),
              { status: 401 },
            ),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_AUTH_REFRESH_UNAUTHORIZED",
      status: 401,
    });
  });

  it("retries once after auth failure and returns operation result", async () => {
    let persistedAuth = STALE_AUTH;
    const persistAuth = vi.fn(async (nextAuth: AgentAuthBundle) => {
      persistedAuth = nextAuth;
    });
    const refreshAuth = vi.fn(async () => FRESH_AUTH);
    const perform = vi.fn(async (auth: AgentAuthBundle) => {
      if (auth.accessToken === STALE_AUTH.accessToken) {
        throw new AppError({
          code: "AUTH_EXPIRED",
          message: "expired",
          status: 401,
          expose: true,
        });
      }

      return "ok";
    });

    const result = await executeWithAgentAuthRefreshRetry({
      key: "agent-alpha",
      getAuth: async () => persistedAuth,
      refreshAuth,
      persistAuth,
      perform,
    });

    expect(result).toBe("ok");
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(persistAuth).toHaveBeenCalledWith(FRESH_AUTH);
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh in flight across concurrent retries", async () => {
    let persistedAuth = STALE_AUTH;
    let refreshCalls = 0;
    const refreshAuth = vi.fn(async () => {
      refreshCalls += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      return FRESH_AUTH;
    });

    const run = () =>
      executeWithAgentAuthRefreshRetry({
        key: "agent-concurrent",
        getAuth: async () => persistedAuth,
        refreshAuth,
        persistAuth: async (nextAuth) => {
          persistedAuth = nextAuth;
        },
        perform: async (auth) => {
          if (auth.accessToken === STALE_AUTH.accessToken) {
            throw new AppError({
              code: "AUTH_EXPIRED",
              message: "expired",
              status: 401,
              expose: true,
            });
          }
          return auth.accessToken;
        },
      });

    const [first, second] = await Promise.all([run(), run()]);

    expect(first).toBe("clw_agt_new");
    expect(second).toBe("clw_agt_new");
    expect(refreshCalls).toBe(1);
  });
});
