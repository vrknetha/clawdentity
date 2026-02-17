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

  it("allows startup with empty bindings for relay mode", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {} satisfies ProxyWorkerBindings,
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

  it("accepts deployed env without OpenClaw vars in relay mode", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        ENVIRONMENT: "development",
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

  it("returns config validation error for malformed OPENCLAW_BASE_URL", async () => {
    const response = await worker.fetch(
      new Request("https://proxy.example.test/health"),
      {
        OPENCLAW_BASE_URL: "bad-url",
      } satisfies ProxyWorkerBindings,
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
});
