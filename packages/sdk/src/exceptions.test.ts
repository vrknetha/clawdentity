import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  AppError,
  createHonoErrorHandler,
  toErrorEnvelope,
} from "./exceptions.js";
import { createLogger } from "./logging.js";
import {
  createRequestContextMiddleware,
  REQUEST_ID_HEADER,
} from "./request-context.js";

describe("exception helpers", () => {
  it("formats AppError into a response envelope", () => {
    const response = toErrorEnvelope(
      new AppError({
        code: "NOT_ALLOWED",
        message: "Not allowed",
        status: 403,
      }),
      "req-12345678",
    );

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "NOT_ALLOWED",
        message: "Not allowed",
        requestId: "req-12345678",
        details: undefined,
      },
    });
  });

  it("returns a standardized error response via Hono handler", async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", createRequestContextMiddleware());
    app.onError(createHonoErrorHandler(createLogger({ service: "sdk-test" })));
    app.get("/boom", () => {
      throw new AppError({
        code: "BROKEN",
        message: "broken route",
        status: 400,
      });
    });

    const res = await app.request("/boom");
    const body = (await res.json()) as {
      error: { code: string; requestId: string };
    };

    expect(res.status).toBe(400);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.error.requestId);
    expect(body.error.code).toBe("BROKEN");
  });
});
