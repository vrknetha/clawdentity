import { ADMIN_BOOTSTRAP_PATH } from "@clawdentity/protocol";
import { describe, expect, it, vi } from "vitest";
import { bootstrapAdmin, persistBootstrapConfig } from "./admin.js";

describe("admin bootstrap helper", () => {
  it("requests bootstrap and returns metadata", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        displayName?: string;
        apiKeyName?: string;
      };
      expect(requestBody.displayName).toBe("Primary Admin");
      expect(requestBody.apiKeyName).toBe("prod-admin");

      return new Response(
        JSON.stringify({
          human: {
            id: "00000000000000000000000000",
            did: "did:claw:human:00000000000000000000000000",
            displayName: "Primary Admin",
            role: "admin",
            status: "active",
          },
          apiKey: {
            id: "01KHH000000000000000000001",
            name: "prod-admin",
            token: "clw_pat_testtoken",
          },
          internalService: {
            id: "01KHH000000000000000000002",
            name: "proxy-pairing",
            secret: "clw_srv_testsecret",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const result = await bootstrapAdmin(
      {
        bootstrapSecret: "bootstrap-secret",
        displayName: "Primary Admin",
        apiKeyName: "prod-admin",
      },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.example.com",
        }),
      },
    );

    expect(result.human.did).toBe("did:claw:human:00000000000000000000000000");
    expect(result.apiKey.token).toBe("clw_pat_testtoken");
    expect(result.internalService.id).toBe("01KHH000000000000000000002");
    expect(result.internalService.secret).toBe("clw_srv_testsecret");
    expect(result.registryUrl).toBe("https://api.example.com/");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledInput, calledInit] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(calledInput.toString()).toBe(
      `https://api.example.com${ADMIN_BOOTSTRAP_PATH}`,
    );
    expect(calledInit.method).toBe("POST");
    expect(
      (calledInit.headers as Record<string, string>)["x-bootstrap-secret"],
    ).toBe("bootstrap-secret");
  });

  it("maps registry bootstrap conflict to stable CLI message", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "ADMIN_BOOTSTRAP_ALREADY_COMPLETED",
            message: "Admin bootstrap has already completed",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      bootstrapAdmin(
        {
          bootstrapSecret: "bootstrap-secret",
        },
        {
          fetchImpl: fetchMock as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://api.example.com",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_ADMIN_BOOTSTRAP_FAILED",
      message: "Admin bootstrap has already completed",
    });
  });

  it("returns stable error when bootstrap response is malformed", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("{}", {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      bootstrapAdmin(
        {
          bootstrapSecret: "bootstrap-secret",
        },
        {
          fetchImpl: fetchMock as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://api.example.com",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      message: "Bootstrap response is invalid",
    });
  });
});

describe("persist bootstrap config", () => {
  it("saves registry url and api key sequentially", async () => {
    const setConfigValueMock = vi.fn(async () => {});

    await persistBootstrapConfig("https://api.example.com/", "token", {
      setConfigValueImpl: setConfigValueMock,
    });

    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      1,
      "registryUrl",
      "https://api.example.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(2, "apiKey", "token");
  });

  it("throws CLI error when persistence fails", async () => {
    const setConfigValueMock = vi.fn(async () => {
      throw new Error("disk-full");
    });

    await expect(
      persistBootstrapConfig("https://api.example.com/", "token", {
        setConfigValueImpl: setConfigValueMock,
      }),
    ).rejects.toMatchObject({
      code: "CLI_ADMIN_BOOTSTRAP_CONFIG_PERSISTENCE_FAILED",
      message: "Failed to save admin credentials locally",
    });
  });
});
