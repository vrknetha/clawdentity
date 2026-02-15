import { describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (_c, next) => {
        await next();
      }),
  };
});

import { parseProxyConfig } from "./config.js";
import { createProxyApp } from "./server.js";

function createHookRouteApp(input: {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  openclawBaseUrl?: string;
}) {
  return createProxyApp({
    config: parseProxyConfig({
      OPENCLAW_BASE_URL: input.openclawBaseUrl ?? "http://openclaw.local",
      OPENCLAW_HOOK_TOKEN: "openclaw-secret",
    }),
    hooks: {
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    },
  });
}

function resolveRequestUrl(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (
    typeof input === "object" &&
    input !== null &&
    "url" in input &&
    typeof (input as { url?: unknown }).url === "string"
  ) {
    return (input as { url: string }).url;
  }

  return "";
}

describe("POST /hooks/agent", () => {
  it("forwards JSON payload and returns upstream status/body", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          accepted: true,
          echoedBody: init?.body,
        }),
        {
          status: 202,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        event: "agent.started",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledInput, calledInit] = fetchMock.mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    const calledHeaders = (calledInit?.headers ?? {}) as Record<string, string>;

    expect(resolveRequestUrl(calledInput)).toBe(
      "http://openclaw.local/hooks/agent",
    );
    expect(calledInit?.method).toBe("POST");
    expect(calledInit?.body).toBe(JSON.stringify({ event: "agent.started" }));
    expect(calledHeaders["content-type"]).toBe("application/json");
    expect(calledHeaders["x-openclaw-token"]).toBe("openclaw-secret");
    expect(typeof calledHeaders["x-request-id"]).toBe("string");
    expect(calledHeaders["x-request-id"].length).toBeGreaterThan(0);

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      accepted: boolean;
      echoedBody: unknown;
    };
    expect(body.accepted).toBe(true);
    expect(body.echoedBody).toBe(JSON.stringify({ event: "agent.started" }));
  });

  it("preserves OpenClaw base path prefixes when building hook URL", async () => {
    let forwardedUrl = "";
    const fetchMock = vi.fn(async (input: unknown) => {
      forwardedUrl = resolveRequestUrl(input);
      return new Response("{}", { status: 202 });
    });
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      openclawBaseUrl: "http://openclaw.local/api",
    });

    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(forwardedUrl).toBe("http://openclaw.local/api/hooks/agent");
  });

  it("rejects non-json content types", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "hello",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(415);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_UNSUPPORTED_MEDIA_TYPE");
    expect(body.error.message).toBe("Content-Type must be application/json");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("rejects invalid JSON payloads", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{not valid json",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_INVALID_JSON");
    expect(body.error.message).toBe("Request body must be valid JSON");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("maps upstream network errors to 502", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(502);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_UPSTREAM_UNAVAILABLE");
    expect(body.error.message).toBe("OpenClaw hook upstream request failed");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("maps upstream timeout errors to 504", async () => {
    const fetchMock = vi.fn(
      (_input: unknown, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) {
            reject(new Error("signal is required"));
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              const timeoutError = new Error("request aborted");
              timeoutError.name = "AbortError";
              reject(timeoutError);
            },
            { once: true },
          );
        }),
    );
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 5,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "agent.started" }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(504);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("PROXY_HOOK_UPSTREAM_TIMEOUT");
    expect(body.error.message).toBe("OpenClaw hook upstream request timed out");
    expect(typeof body.error.requestId).toBe("string");
  });
});
