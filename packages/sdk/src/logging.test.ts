import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createLogger, createRequestLoggingMiddleware } from "./logging.js";
import { createRequestContextMiddleware } from "./request-context.js";

describe("logging helpers", () => {
  it("writes structured JSON logs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = createLogger({ service: "sdk-test" });

    logger.info("hello.world", { requestId: "req-12345678" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [line] = spy.mock.calls[0] ?? [];
    expect(typeof line).toBe("string");
    expect(line).toContain('"service":"sdk-test"');
    expect(line).toContain('"message":"hello.world"');
    expect(line).toContain('"requestId":"req-12345678"');
    spy.mockRestore();
  });

  it("logs completion even when route throws", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = new Hono<{ Variables: { requestId: string } }>();
    const logger = createLogger({ service: "sdk-test" });
    app.use("*", createRequestContextMiddleware());
    app.use("*", createRequestLoggingMiddleware(logger));
    app.onError(() => new Response("failed", { status: 500 }));
    app.get("/fail", () => {
      throw new Error("boom");
    });

    const res = await app.request("/fail");
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalled();
    const line = String(spy.mock.calls.at(-1)?.[0] ?? "");
    expect(line).toContain('"message":"request.completed"');
    expect(line).toContain('"path":"/fail"');
    expect(line).toContain('"status":500');
    spy.mockRestore();
  });
});
