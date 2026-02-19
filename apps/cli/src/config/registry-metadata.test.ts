import { describe, expect, it, vi } from "vitest";
import {
  fetchRegistryMetadata,
  normalizeRegistryUrl,
  toRegistryRequestUrl,
} from "./registry-metadata.js";

const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

describe("registry metadata helpers", () => {
  it("normalizes registry URLs", () => {
    expect(normalizeRegistryUrl("https://registry.clawdentity.com")).toBe(
      "https://registry.clawdentity.com/",
    );
  });

  it("builds request URL from registry base", () => {
    expect(
      toRegistryRequestUrl("https://registry.clawdentity.com", "/v1/metadata"),
    ).toBe("https://registry.clawdentity.com/v1/metadata");
  });

  it("fetches metadata with proxy URL", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(200, {
        status: "ok",
        environment: "production",
        version: "sha-123",
        registryUrl: "https://registry.clawdentity.com",
        proxyUrl: "https://proxy.clawdentity.com",
      }),
    );

    const result = await fetchRegistryMetadata(
      "https://registry.clawdentity.com",
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(result).toEqual({
      environment: "production",
      version: "sha-123",
      registryUrl: "https://registry.clawdentity.com/",
      proxyUrl: "https://proxy.clawdentity.com/",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.clawdentity.com/v1/metadata",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to input registry URL when metadata omits registryUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(200, {
        status: "ok",
        proxyUrl: "https://dev.proxy.clawdentity.com",
      }),
    );

    const result = await fetchRegistryMetadata(
      "https://dev.registry.clawdentity.com",
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(result.registryUrl).toBe("https://dev.registry.clawdentity.com/");
    expect(result.proxyUrl).toBe("https://dev.proxy.clawdentity.com/");
  });

  it("fails when metadata endpoint is unavailable", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(503, {
        error: { code: "DEP_UNAVAILABLE", message: "down" },
      }),
    );

    await expect(
      fetchRegistryMetadata("https://registry.clawdentity.com", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "CLI_REGISTRY_METADATA_FETCH_FAILED",
      message: "Registry metadata request failed (503). Try again later.",
    });
  });

  it("fails when metadata payload is invalid", async () => {
    const fetchImpl = vi.fn(async () =>
      createJsonResponse(200, {
        status: "ok",
      }),
    );

    await expect(
      fetchRegistryMetadata("https://registry.clawdentity.com", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "CLI_REGISTRY_METADATA_INVALID_RESPONSE",
    });
  });

  it("fails when registry URL is invalid", async () => {
    await expect(
      fetchRegistryMetadata("not-a-url", {
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "CLI_REGISTRY_URL_INVALID",
    });
  });
});
