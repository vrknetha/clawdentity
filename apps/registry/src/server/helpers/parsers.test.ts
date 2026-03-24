import { describe, expect, it } from "vitest";
import { resolvePublicUrl } from "./parsers.js";

describe("registry public url helpers", () => {
  it("uses the forwarded origin for registry-facing loopback urls", () => {
    expect(
      resolvePublicUrl({
        request: new Request("http://127.0.0.1:8788/v1/health", {
          headers: {
            host: "registry.example.test",
            "x-forwarded-host": "registry.example.test",
            "x-forwarded-proto": "https",
          },
        }),
        configuredUrl: "http://127.0.0.1:8788/",
      }),
    ).toBe("https://registry.example.test/");
  });

  it("preserves the configured proxy port when rewriting to the caller-facing host", () => {
    expect(
      resolvePublicUrl({
        request: new Request("http://host.docker.internal:8788/v1/metadata", {
          headers: {
            host: "host.docker.internal:8788",
            "x-forwarded-host": "host.docker.internal:8788",
            "x-forwarded-proto": "http",
          },
        }),
        configuredUrl: "http://127.0.0.1:8787",
        preserveConfiguredPort: true,
      }),
    ).toBe("http://host.docker.internal:8787");
  });

  it("treats bracketed ipv6 loopback urls as local origins", () => {
    expect(
      resolvePublicUrl({
        request: new Request("http://[::1]:8788/v1/health", {
          headers: {
            host: "registry.example.test",
            "x-forwarded-host": "registry.example.test",
            "x-forwarded-proto": "https",
          },
        }),
        configuredUrl: "http://[::1]:8788/",
      }),
    ).toBe("https://registry.example.test/");
  });
});
