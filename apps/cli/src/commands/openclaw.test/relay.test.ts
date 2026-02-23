import { describe, expect, it } from "vitest";
import {
  createOpenclawInviteCode,
  runOpenclawRelayTest,
  runOpenclawRelayWebsocketTest,
  setupOpenclawRelay,
  setupOpenclawRelayFromInvite,
} from "../openclaw.js";
import {
  connectorReadyFetch,
  createSandbox,
  resolveConfigFixture,
  restoreEnvVar,
  seedLocalAgentCredentials,
  seedPeersConfig,
} from "./helpers.js";

describe("openclaw relay diagnostics", () => {
  it("returns relay test success for accepted probe", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () => new Response(null, { status: 204 }),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("success");
      expect(result.httpStatus).toBe(204);
      expect(result.endpoint).toBe("http://127.0.0.1:18789/hooks/send-to-peer");
    } finally {
      sandbox.cleanup();
    }
  });

  it("auto-selects peer for relay test when exactly one peer is configured", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () => new Response(null, { status: 204 }),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("success");
      expect(result.peerAlias).toBe("beta");
    } finally {
      sandbox.cleanup();
    }
  });

  it("uses hook token from relay runtime config when relay test option/env is unset", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");
    const previousHookToken = process.env.OPENCLAW_HOOK_TOKEN;
    delete process.env.OPENCLAW_HOOK_TOKEN;

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      let sentHookToken: string | undefined;
      await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async (_input, init) => {
          const headers = new Headers(init?.headers);
          sentHookToken = headers.get("x-openclaw-token") ?? undefined;
          return new Response(null, { status: 204 });
        },
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(typeof sentHookToken).toBe("string");
      expect(sentHookToken?.length ?? 0).toBeGreaterThan(0);
    } finally {
      restoreEnvVar("OPENCLAW_HOOK_TOKEN", previousHookToken);
      sandbox.cleanup();
    }
  });

  it("returns relay test failure when probe is rejected", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: async () =>
          new Response("connector offline", { status: 500 }),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("failure");
      expect(result.httpStatus).toBe(500);
      expect(result.message).toBe(
        "Relay probe failed inside local relay pipeline",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("returns relay websocket test success when connector websocket is connected", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      const invite = createOpenclawInviteCode({
        did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
        proxyUrl: "https://beta.example.com/hooks/agent",
        peerAlias: "beta",
      });

      await setupOpenclawRelayFromInvite("alpha", {
        inviteCode: invite.code,
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayWebsocketTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("success");
      expect(result.message).toBe(
        "Connector websocket is connected for paired relay",
      );
      expect(result.connectorStatusUrl).toBe(
        "http://127.0.0.1:19400/v1/status",
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("auto-selects peer for relay websocket test when exactly one peer is configured", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const result = await runOpenclawRelayWebsocketTest({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: connectorReadyFetch(),
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("success");
      expect(result.peerAlias).toBe("beta");
    } finally {
      sandbox.cleanup();
    }
  });

  it("returns relay websocket test failure when connector websocket is disconnected", async () => {
    const sandbox = createSandbox();
    seedLocalAgentCredentials(sandbox.homeDir, "alpha");

    try {
      await setupOpenclawRelay("alpha", {
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        transformSource: sandbox.transformSourcePath,
      });
      seedPeersConfig(sandbox.homeDir, {
        beta: {
          did: "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7",
          proxyUrl: "https://beta.example.com/hooks/agent",
        },
      });

      const disconnectedConnectorFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            status: "ok",
            websocket: {
              connected: false,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );

      const result = await runOpenclawRelayWebsocketTest({
        peer: "beta",
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        fetchImpl: disconnectedConnectorFetch,
        resolveConfigImpl: resolveConfigFixture,
      });

      expect(result.status).toBe("failure");
      expect(result.message).toBe("Connector websocket is not connected");
      expect(result.remediationHint).toBe(
        "Run: clawdentity openclaw setup <agentName>",
      );
    } finally {
      sandbox.cleanup();
    }
  });
});
