import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeBase64url,
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { parseFrame, serializeFrame } from "../frames.js";

export type Sandbox = {
  cleanup: () => void;
  rootDir: string;
};

export type WsHarness = {
  cleanup: () => Promise<void>;
  sendDeliverFrame: (input: {
    payload: unknown;
    requestId: string;
    fromAgentDid?: string;
    toAgentDid?: string;
  }) => Promise<void>;
  waitForDeliverAck: (requestId: string) => Promise<void>;
  wsUrl: string;
};

const DID_AUTHORITY = "registry.example.test";

export const RUNTIME_ENV_KEYS = [
  "CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS",
  "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
  "CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS",
  "CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS",
  "CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS",
  "CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS",
] as const;

export function createSandbox(): Sandbox {
  const rootDir = mkdtempSync(join(tmpdir(), "clawdentity-connector-runtime-"));
  mkdirSync(join(rootDir, "agents", "alpha"), { recursive: true });

  return {
    rootDir,
    cleanup: () => {
      rmSync(rootDir, {
        force: true,
        recursive: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    },
  };
}

export async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate test port"));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export async function createWsHarness(port: number): Promise<WsHarness> {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    path: "/v1/relay/connect",
    port,
  });

  const frames: unknown[] = [];
  let socket: import("ws").WebSocket | undefined;

  const connectedPromise = new Promise<void>((resolve) => {
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (payload) => {
        frames.push(parseFrame(payload.toString()));
      });
      resolve();
    });
  });

  const waitForDeliverAck = async (requestId: string): Promise<void> => {
    await vi.waitFor(() => {
      expect(
        frames.some((frame) => {
          if (!frame || typeof frame !== "object") {
            return false;
          }
          const typed = frame as {
            ackId?: string;
            accepted?: boolean;
            type?: string;
          };
          return (
            typed.type === "deliver_ack" &&
            typed.ackId === requestId &&
            typed.accepted === true
          );
        }),
      ).toBe(true);
    });
  };

  const sendDeliverFrame = async (input: {
    payload: unknown;
    requestId: string;
    fromAgentDid?: string;
    toAgentDid?: string;
  }): Promise<void> => {
    await connectedPromise;
    if (socket === undefined) {
      throw new Error("WebSocket connection was not established");
    }

    socket.send(
      serializeFrame({
        v: 1,
        type: "deliver",
        id: input.requestId,
        ts: "2026-02-20T00:00:00.000Z",
        fromAgentDid:
          input.fromAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(1)),
        toAgentDid:
          input.toAgentDid ?? makeAgentDid(DID_AUTHORITY, generateUlid(2)),
        payload: input.payload,
      }),
    );
  };

  return {
    wsUrl: `ws://127.0.0.1:${port}/v1/relay/connect`,
    sendDeliverFrame,
    waitForDeliverAck,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

export function createRuntimeCredentials(input: { issuer?: string } = {}) {
  const agentDid = makeAgentDid(DID_AUTHORITY, generateUlid(100));
  const ownerDid = makeHumanDid(DID_AUTHORITY, generateUlid(101));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.issuer ?? "https://registry.example.test",
    sub: agentDid,
    ownerDid,
    name: "alpha",
    framework: "openclaw",
    cnf: {
      jwk: {
        kty: "OKP" as const,
        crv: "Ed25519" as const,
        x: encodeBase64url(randomBytes(32)),
      },
    },
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 3600,
    jti: generateUlid(nowSeconds * 1000),
  };
  const header = {
    alg: "EdDSA",
    typ: "AIT",
    kid: "test-registry-kid",
  };

  return {
    agentDid,
    ait: [
      encodeBase64url(Buffer.from(JSON.stringify(header), "utf8")),
      encodeBase64url(Buffer.from(JSON.stringify(payload), "utf8")),
      "signature",
    ].join("."),
    secretKey: Buffer.from(randomBytes(32)).toString("base64url"),
    accessToken: "access-token",
    accessExpiresAt: "2100-01-01T00:00:00.000Z",
    refreshToken: "refresh-token",
    refreshExpiresAt: "2100-01-01T00:00:00.000Z",
    tokenType: "Bearer" as const,
  };
}

export async function writeRelayRuntimeConfig(
  configDir: string,
  token: string,
): Promise<void> {
  await writeFile(
    join(configDir, "openclaw-relay.json"),
    `${JSON.stringify({ openclawHookToken: token }, null, 2)}\n`,
    "utf8",
  );
}

export async function readConnectorStatus(
  outboundUrl: string,
): Promise<unknown> {
  const statusUrl = new URL("/v1/status", outboundUrl).toString();
  const response = await fetch(statusUrl);
  expect(response.status).toBe(200);
  return await response.json();
}

export function resetRuntimeTestEnv(): void {
  vi.restoreAllMocks();
  for (const key of RUNTIME_ENV_KEYS) {
    delete process.env[key];
  }
}
