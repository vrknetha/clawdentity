import { parseRegistryConfig } from "@clawdentity/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  resolveEventBusBackend,
  resolveRegistryEventBus,
} from "./event-bus.js";

function createProductionConfig(overrides = {}) {
  return parseRegistryConfig(
    {
      ENVIRONMENT: "production",
      PROXY_URL: "https://proxy.clawdentity.com",
      REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
      EVENT_BUS_BACKEND: "queue",
      BOOTSTRAP_SECRET: "bootstrap-secret",
      BOOTSTRAP_INTERNAL_SERVICE_ID: "svc-registry-proxy",
      BOOTSTRAP_INTERNAL_SERVICE_SECRET: "secret-registry-proxy",
      REGISTRY_SIGNING_KEY: "signing-private-key",
      REGISTRY_SIGNING_KEYS: JSON.stringify([
        {
          kid: "reg-key-1",
          alg: "EdDSA",
          crv: "Ed25519",
          x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
          status: "active",
        },
      ]),
      ...overrides,
    },
    { requireRuntimeKeys: true },
  );
}

describe("registry event bus helpers", () => {
  it("keeps production on the queue backend", () => {
    expect(resolveEventBusBackend(createProductionConfig())).toBe("queue");
  });

  it("returns a queue-backed event bus when binding is present", async () => {
    const send = vi.fn(async () => undefined);
    const bus = resolveRegistryEventBus({
      config: createProductionConfig(),
      bindings: {
        DB: {} as D1Database,
        ENVIRONMENT: "production",
        EVENT_BUS_BACKEND: "queue",
        EVENT_BUS_QUEUE: { send },
        PROXY_URL: "https://proxy.clawdentity.com",
        REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
        BOOTSTRAP_SECRET: "bootstrap-secret",
        REGISTRY_SIGNING_KEY: "signing-private-key",
        REGISTRY_SIGNING_KEYS: JSON.stringify([
          {
            kid: "reg-key-1",
            alg: "EdDSA",
            crv: "Ed25519",
            x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            status: "active",
          },
        ]),
      } as never,
    });

    await bus.publish({
      id: "evt-1",
      type: "registry.test",
      version: "v1",
      timestampUtc: "2026-03-12T00:00:00.000Z",
      initiatedByAccountId: null,
      data: { ok: true },
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails fast when production queue binding is missing", () => {
    try {
      resolveRegistryEventBus({
        config: createProductionConfig(),
        bindings: {
          DB: {} as D1Database,
          ENVIRONMENT: "production",
          EVENT_BUS_BACKEND: "queue",
          PROXY_URL: "https://proxy.clawdentity.com",
          REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
          BOOTSTRAP_SECRET: "bootstrap-secret",
          REGISTRY_SIGNING_KEY: "signing-private-key",
          REGISTRY_SIGNING_KEYS: JSON.stringify([
            {
              kid: "reg-key-1",
              alg: "EdDSA",
              crv: "Ed25519",
              x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
              status: "active",
            },
          ]),
        } as never,
      });
      throw new Error("Expected resolveRegistryEventBus to throw");
    } catch (error) {
      expect(error).toMatchObject({
        message: "Registry configuration is invalid",
        details: {
          fieldErrors: {
            EVENT_BUS_QUEUE: [
              "EVENT_BUS_QUEUE is required when EVENT_BUS_BACKEND is queue",
            ],
          },
        },
      });
    }
  });
});
