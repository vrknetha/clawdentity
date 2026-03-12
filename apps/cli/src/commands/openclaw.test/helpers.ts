import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config/manager.js";

export type OpenclawSandbox = {
  cleanup: () => void;
  homeDir: string;
  openclawDir: string;
  transformSourcePath: string;
};

export function createSandbox(): OpenclawSandbox {
  const root = mkdtempSync(join(tmpdir(), "clawdentity-cli-openclaw-"));
  const homeDir = join(root, "home");
  const openclawDir = join(root, "openclaw");
  const transformSourcePath = join(root, "relay-to-peer.mjs");

  mkdirSync(homeDir, { recursive: true });
  mkdirSync(openclawDir, { recursive: true });

  writeFileSync(
    join(openclawDir, "openclaw.json"),
    JSON.stringify(
      {
        hooks: {
          enabled: false,
          mappings: [],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    transformSourcePath,
    "export default async function relay(ctx){ return ctx?.payload ?? null; }\n",
    "utf8",
  );

  return {
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    homeDir,
    openclawDir,
    transformSourcePath,
  };
}

export function resolveCliStateDir(homeDir: string): string {
  return getConfigDir({ homeDir });
}

export function seedLocalAgentCredentials(
  homeDir: string,
  agentName: string,
): void {
  const agentDir = join(resolveCliStateDir(homeDir), "agents", agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "secret.key"), "secret-key-value", "utf8");
  writeFileSync(join(agentDir, "ait.jwt"), "mock.ait.jwt", "utf8");
}

export function seedPeersConfig(
  homeDir: string,
  peers: Record<
    string,
    { did: string; proxyUrl: string; agentName?: string; humanName?: string }
  >,
): void {
  const peersPath = join(resolveCliStateDir(homeDir), "peers.json");
  mkdirSync(dirname(peersPath), { recursive: true });
  writeFileSync(peersPath, `${JSON.stringify({ peers }, null, 2)}\n`, "utf8");
}

export function seedPendingGatewayApprovals(
  openclawDir: string,
  requestIds: string[] = ["request-1"],
): string {
  const pendingPath = join(openclawDir, "devices", "pending.json");
  mkdirSync(dirname(pendingPath), { recursive: true });

  const pending = Object.fromEntries(
    requestIds.map((requestId) => [
      requestId,
      {
        requestId,
      },
    ]),
  );

  writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf8");
  return pendingPath;
}

export function connectorReadyFetch(): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        status: "ok",
        websocket: {
          connected: true,
        },
        inbound: {
          pending: {
            pendingCount: 0,
            pendingBytes: 0,
          },
          deadLetter: {
            deadLetterCount: 0,
            deadLetterBytes: 0,
          },
          replay: {
            replayerActive: false,
          },
          openclawHook: {
            url: "http://127.0.0.1:18789/hooks/agent",
            lastAttemptStatus: "ok",
          },
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
}

export const resolveConfigFixture = async () => ({
  registryUrl: "https://api.example.com",
  proxyUrl: "https://proxy.example.com",
  apiKey: "test-api-key",
});

export function restoreEnvVar(
  key: keyof NodeJS.ProcessEnv,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = previous;
}
