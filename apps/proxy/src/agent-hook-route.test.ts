import { describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", async () => {
  const { createMiddleware } = await import("hono/factory");

  return {
    createProxyAuthMiddleware: () =>
      createMiddleware(async (c, next) => {
        const missingAuth = c.req.header("x-test-missing-auth") === "1";
        if (!missingAuth) {
          const dirtyAuth = c.req.header("x-test-dirty-auth") === "1";
          c.set("auth", {
            agentDid: dirtyAuth
              ? `\u0000 did:claw:agent:${"a".repeat(200)} \n`
              : "did:claw:agent:alpha",
            ownerDid: dirtyAuth
              ? " \t did:claw:owner:alpha\u0007"
              : "did:claw:owner:alpha",
            issuer: dirtyAuth
              ? ` https://registry.example.com/${"b".repeat(260)} `
              : "https://registry.example.com",
            aitJti: dirtyAuth ? `\u0001${"j".repeat(100)}` : "ait-jti-alpha",
            cnfPublicKey: "test-public-key",
          });
        }
        await next();
      }),
  };
});

import { parseProxyConfig } from "./config.js";
import { createProxyApp } from "./server.js";

function hasDisallowedControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12) {
      return true;
    }
    if ((code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

function createHookRouteApp(input: {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  openclawBaseUrl?: string;
  injectIdentityIntoMessage?: boolean;
}) {
  return createProxyApp({
    config: parseProxyConfig({
      OPENCLAW_BASE_URL: input.openclawBaseUrl ?? "http://openclaw.local",
      OPENCLAW_HOOK_TOKEN: "openclaw-secret",
      INJECT_IDENTITY_INTO_MESSAGE: input.injectIdentityIntoMessage,
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

  it("prepends sanitized identity block when message injection is enabled", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
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
      injectIdentityIntoMessage: true,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "Summarize this payload",
      }),
    });

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, calledInit] = fetchMock.mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    const forwardedPayload = JSON.parse(String(calledInit?.body)) as {
      message: string;
    };
    expect(forwardedPayload.message).toBe(
      [
        "[Clawdentity Identity]",
        "agentDid: did:claw:agent:alpha",
        "ownerDid: did:claw:owner:alpha",
        "issuer: https://registry.example.com",
        "aitJti: ait-jti-alpha",
        "",
        "Summarize this payload",
      ].join("\n"),
    );
  });

  it("keeps payload unchanged when message injection is enabled but auth is missing", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(String(init?.body), { status: 202 });
    });
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      injectIdentityIntoMessage: true,
    });
    const rawPayload = {
      message: "No auth context here",
      event: "agent.started",
    };

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-missing-auth": "1",
      },
      body: JSON.stringify(rawPayload),
    });

    expect(response.status).toBe(202);
    const [, calledInit] = fetchMock.mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    expect(String(calledInit?.body)).toBe(JSON.stringify(rawPayload));
  });

  it("keeps payload unchanged when message is missing or non-string", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(String(init?.body), { status: 202 });
    });
    const app = createHookRouteApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      injectIdentityIntoMessage: true,
    });

    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        event: "agent.started",
      }),
    });

    await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: { nested: true },
      }),
    });

    const [, firstInit] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
    expect(String(firstInit.body)).toBe(
      JSON.stringify({ event: "agent.started" }),
    );
    expect(String(secondInit.body)).toBe(
      JSON.stringify({ message: { nested: true } }),
    );
  });

  it("sanitizes identity fields and enforces length limits", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
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
      injectIdentityIntoMessage: true,
    });

    const response = await app.request("/hooks/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-dirty-auth": "1",
      },
      body: JSON.stringify({
        message: "Hello world",
      }),
    });

    expect(response.status).toBe(202);
    const [, calledInit] = fetchMock.mock.calls[0] as [
      unknown,
      RequestInit | undefined,
    ];
    const forwardedPayload = JSON.parse(String(calledInit?.body)) as {
      message: string;
    };
    expect(forwardedPayload.message).toContain("[Clawdentity Identity]");

    const identityBlock = forwardedPayload.message.split("\n\n")[0];
    expect(hasDisallowedControlCharacter(identityBlock)).toBe(false);

    const identityLines = identityBlock.split("\n");
    expect(identityLines[1].length).toBeLessThanOrEqual(171);
    expect(identityLines[2].length).toBeLessThanOrEqual(171);
    expect(identityLines[3].length).toBeLessThanOrEqual(208);
    expect(identityLines[4].length).toBeLessThanOrEqual(72);
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
