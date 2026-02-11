import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createRequestContextMiddleware,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "./request-context.js";

describe("request context helpers", () => {
  it("keeps a valid request id", () => {
    expect(resolveRequestId("custom-id-1234")).toBe("custom-id-1234");
  });

  it("generates a request id for invalid values", () => {
    expect(resolveRequestId("bad id")).toBeTruthy();
    expect(resolveRequestId(undefined)).toBeTruthy();
  });

  it("injects request id into response headers", async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", createRequestContextMiddleware());
    app.get("/health", (c) => c.json({ requestId: c.get("requestId") }));

    const res = await app.request("/health");
    const body = (await res.json()) as { requestId: string };

    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.requestId);
    expect(body.requestId.length).toBeGreaterThan(7);
  });
});
