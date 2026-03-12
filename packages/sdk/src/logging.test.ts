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

  it("suppresses levels below the configured minimum", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createLogger({ service: "sdk-test" }, { minLevel: "warn" });

    logger.info("hello.info");
    logger.warn("hello.warn");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("skips successful fast request logs when onlyErrors is enabled", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = new Hono<{ Variables: { requestId: string } }>();
    const logger = createLogger({ service: "sdk-test" });
    app.use("*", createRequestContextMiddleware());
    app.use("*", createRequestLoggingMiddleware(logger, { onlyErrors: true }));
    app.get("/ok", () => new Response("ok"));

    const res = await app.request("/ok");

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("elevates slow completion logs when configured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = new Hono<{ Variables: { requestId: string } }>();
    const logger = createLogger({ service: "sdk-test" });
    app.use("*", createRequestContextMiddleware());
    app.use(
      "*",
      createRequestLoggingMiddleware(logger, {
        onlyErrors: true,
        slowThresholdMs: 0,
        errorOrSlowLogLevel: "warn",
      }),
    );
    app.get("/ok", () => new Response("ok"));

    const res = await app.request("/ok");

    expect(res.status).toBe(200);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const line = String(warnSpy.mock.calls.at(-1)?.[0] ?? "");
    expect(line).toContain('"message":"request.completed"');
    expect(line).toContain('"slow":true');

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
