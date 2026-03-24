import { describe, expect, it } from "vitest";
import {
  isLoopbackRegistryUrl,
  resolveExpectedIssuer,
} from "../auth-middleware/url.js";

describe("proxy auth url helpers", () => {
  it("keeps remote registry origins unchanged", () => {
    expect(
      resolveExpectedIssuer(
        "https://registry.clawdentity.com",
        new Request("https://proxy.clawdentity.com/protected"),
      ),
    ).toBe("https://registry.clawdentity.com");
  });

  it("keeps loopback registry origin for localhost requests", () => {
    expect(
      resolveExpectedIssuer(
        "http://127.0.0.1:8788",
        new Request("http://localhost:8787/protected"),
      ),
    ).toBe("http://127.0.0.1:8788");
  });

  it("maps loopback registry origin to docker-facing host when present", () => {
    expect(
      resolveExpectedIssuer(
        "http://127.0.0.1:8788",
        new Request("http://host.docker.internal:8787/protected", {
          headers: {
            host: "host.docker.internal:8787",
            "x-forwarded-host": "host.docker.internal:8787",
            "x-forwarded-proto": "http",
          },
        }),
      ),
    ).toBe("http://host.docker.internal:8788");
  });

  it("keeps the registry port when remapping to a forwarded host", () => {
    expect(
      resolveExpectedIssuer(
        "http://127.0.0.1:8788",
        new Request("http://127.0.0.1:8787/protected", {
          headers: {
            host: "registry.example.test:9443",
            "x-forwarded-host": "registry.example.test:9443",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe("https://registry.example.test:8788");
  });

  it("drops the loopback registry port when the forwarded public host omits it", () => {
    expect(
      resolveExpectedIssuer(
        "http://127.0.0.1:8788",
        new Request("http://127.0.0.1:8787/protected", {
          headers: {
            host: "registry.example.test",
            "x-forwarded-host": "registry.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe("https://registry.example.test");
  });

  it("treats bracketed ipv6 loopback registry urls as local", () => {
    expect(
      resolveExpectedIssuer(
        "http://[::1]:8788",
        new Request("http://[::1]:8787/protected", {
          headers: {
            host: "registry.example.test",
            "x-forwarded-host": "registry.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      ),
    ).toBe("https://registry.example.test");
  });

  it("detects loopback registry urls", () => {
    expect(isLoopbackRegistryUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isLoopbackRegistryUrl("http://[::1]:8788")).toBe(true);
    expect(isLoopbackRegistryUrl("https://registry.clawdentity.com")).toBe(
      false,
    );
  });
});
