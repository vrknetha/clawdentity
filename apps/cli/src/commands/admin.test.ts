import { describe, expect, it, vi } from "vitest";
import { bootstrapAdmin } from "./admin.js";

describe("admin bootstrap helper", () => {
  it("bootstraps admin and persists registryUrl + apiKey", async () => {
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
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const setConfigValueMock = vi.fn(async () => {});

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
        setConfigValueImpl: setConfigValueMock,
      },
    );

    expect(result.human.did).toBe("did:claw:human:00000000000000000000000000");
    expect(result.apiKey.token).toBe("clw_pat_testtoken");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledInput, calledInit] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(calledInput.toString()).toBe(
      "https://api.example.com/v1/admin/bootstrap",
    );
    expect(calledInit.method).toBe("POST");
    expect(
      (calledInit.headers as Record<string, string>)["x-bootstrap-secret"],
    ).toBe("bootstrap-secret");
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      1,
      "registryUrl",
      "https://api.example.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      2,
      "apiKey",
      "clw_pat_testtoken",
    );
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
          setConfigValueImpl: vi.fn(async () => {}),
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
          setConfigValueImpl: vi.fn(async () => {}),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      message: "Bootstrap response is invalid",
    });
  });
});
