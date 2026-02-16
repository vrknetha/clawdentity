import { describe, expect, it, vi } from "vitest";
import { PROXY_VERSION } from "./index.js";
import worker, { type ProxyWorkerBindings } from "./worker.js";

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

describe("proxy worker", () => {
  it("serves /health with parsed runtime config from bindings", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        ENVIRONMENT: "local",
        OPENCLAW_HOOK_TOKEN: "proxy-hook-token",
      } satisfies ProxyWorkerBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      version: string;
      environment: string;
    };
    expect(payload).toEqual({
      status: "ok",
      version: PROXY_VERSION,
      environment: "local",
    });
  });

  it("returns config validation error when required bindings are missing", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {} satisfies ProxyWorkerBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
  });

  it("returns config validation error when deployed env uses loopback upstream", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        ENVIRONMENT: "development",
        OPENCLAW_HOOK_TOKEN: "proxy-hook-token",
      } satisfies ProxyWorkerBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as {
      error: {
        code: string;
        details: {
          fieldErrors?: Record<string, string[]>;
        };
      };
    };
    expect(payload.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(payload.error.details.fieldErrors?.OPENCLAW_BASE_URL?.[0]).toContain(
      "externally reachable URL",
    );
  });

  it("accepts non-loopback upstream in deployed env", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        ENVIRONMENT: "development",
        OPENCLAW_HOOK_TOKEN: "proxy-hook-token",
        OPENCLAW_BASE_URL: "https://openclaw-dev.internal.example",
      } satisfies ProxyWorkerBindings,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      status: string;
      environment: string;
    };
    expect(payload.status).toBe("ok");
    expect(payload.environment).toBe("development");
  });
});
