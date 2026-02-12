import { REQUEST_ID_HEADER } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import app, { createRegistryApp } from "./server.js";

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await app.request(
      "/health",
      {},
      { DB: {}, ENVIRONMENT: "test" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      version: "0.0.0",
      environment: "test",
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it("returns config validation error for invalid environment", async () => {
    const res = await createRegistryApp().request(
      "/health",
      {},
      { DB: {}, ENVIRONMENT: "local" },
    );
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(body.error.message).toBe("Registry configuration is invalid");
  });
});
