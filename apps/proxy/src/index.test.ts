import { describe, expect, it } from "vitest";
import { ProxyConfigError } from "./config.js";
import {
  initializeProxyRuntime,
  PROXY_VERSION,
  resolveProxyVersion,
} from "./index.js";

describe("proxy", () => {
  it("exports PROXY_VERSION", () => {
    expect(PROXY_VERSION).toBe("0.0.0");
  });

  it("initializes runtime with validated config", () => {
    const runtime = initializeProxyRuntime({});

    expect(runtime.version).toBe(PROXY_VERSION);
    expect(runtime.config.listenPort).toBe(4000);
  });

  it("fails startup when config is invalid", () => {
    expect(() =>
      initializeProxyRuntime({ OPENCLAW_BASE_URL: "bad-url" }),
    ).toThrow(ProxyConfigError);
  });

  it("supports relay runtime startup without OpenClaw vars", () => {
    const runtime = initializeProxyRuntime({});

    expect(runtime.version).toBe(PROXY_VERSION);
    expect(runtime.config.openclawBaseUrl).toBe("http://127.0.0.1:18789");
  });

  it("prefers APP_VERSION for runtime version", () => {
    expect(
      resolveProxyVersion({
        APP_VERSION: "sha-1234",
        PROXY_VERSION: "ignored",
      }),
    ).toBe("sha-1234");
  });

  it("falls back to PROXY_VERSION binding when APP_VERSION is absent", () => {
    expect(resolveProxyVersion({ PROXY_VERSION: "proxy-1.2.3" })).toBe(
      "proxy-1.2.3",
    );
  });
});
