import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@clawdentity/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorE2eeManager } from "./e2ee.js";

const ALPHA_DID = "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
const BETA_DID = "did:claw:agent:01HF7YAT31JZHSMW1CG6Q6MHB8";

type StoredIdentity = {
  keyId: string;
  x25519PublicKey: string;
  x25519SecretKey: string;
};

type StoredSession = {
  sessionId: string;
  peerDid: string;
  peerKeyId: string;
  localKeyId: string;
  epoch: number;
  epochStartedAtMs: number;
  sendCounter: number;
  recvCounter: number;
  rootKey: string;
  sendChainKey: string;
  recvChainKey: string;
};

const tempDirs: string[] = [];

async function createTempConfigDir(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "clawdentity-connector-e2ee-"),
  );
  tempDirs.push(directory);
  return directory;
}

async function readIdentity(input: {
  configDir: string;
  agentName: string;
}): Promise<StoredIdentity> {
  const path = join(
    input.configDir,
    "agents",
    input.agentName,
    "e2ee-identity.json",
  );
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    keyId: string;
    x25519PublicKey: string;
    x25519SecretKey: string;
  };
  return {
    keyId: parsed.keyId,
    x25519PublicKey: parsed.x25519PublicKey,
    x25519SecretKey: parsed.x25519SecretKey,
  };
}

async function readSession(input: {
  configDir: string;
  agentName: string;
  peerDid: string;
}): Promise<StoredSession | undefined> {
  const path = join(
    input.configDir,
    "agents",
    input.agentName,
    "e2ee-sessions.json",
  );
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    sessionsByPeerDid?: Record<string, StoredSession>;
  };
  return parsed.sessionsByPeerDid?.[input.peerDid];
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("ConnectorE2eeManager", () => {
  it("creates and reuses local e2ee identity", async () => {
    const configDir = await createTempConfigDir();
    const logger = createLogger({ service: "test", module: "e2ee" });
    const manager = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });

    await manager.initialize();
    const firstIdentity = await readIdentity({
      configDir,
      agentName: "alpha",
    });

    await manager.initialize();
    const secondIdentity = await readIdentity({
      configDir,
      agentName: "alpha",
    });

    expect(firstIdentity.keyId).toBe(secondIdentity.keyId);
    expect(firstIdentity.x25519PublicKey).toBe(secondIdentity.x25519PublicKey);
  });

  it("encrypts outbound payload and decrypts inbound payload", async () => {
    const configDir = await createTempConfigDir();
    const logger = createLogger({ service: "test", module: "e2ee" });

    const alpha = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });
    const beta = new ConnectorE2eeManager({
      agentDid: BETA_DID,
      agentName: "beta",
      configDir,
      logger,
    });

    await alpha.initialize();
    await beta.initialize();

    const alphaIdentity = await readIdentity({ configDir, agentName: "alpha" });
    const betaIdentity = await readIdentity({ configDir, agentName: "beta" });

    await writeFile(
      join(configDir, "peers.json"),
      `${JSON.stringify(
        {
          peers: {
            alpha: {
              did: ALPHA_DID,
              proxyUrl: "https://alpha.proxy.example/hooks/agent",
              e2ee: {
                keyId: alphaIdentity.keyId,
                x25519PublicKey: alphaIdentity.x25519PublicKey,
              },
            },
            beta: {
              did: BETA_DID,
              proxyUrl: "https://beta.proxy.example/hooks/agent",
              e2ee: {
                keyId: betaIdentity.keyId,
                x25519PublicKey: betaIdentity.x25519PublicKey,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plaintext = {
      message: "hello peer",
      metadata: {
        round: 1,
      },
    };

    const envelope = await alpha.encryptOutbound({
      peerAlias: "beta",
      peerDid: BETA_DID,
      payload: plaintext,
    });

    expect(envelope.kind).toBe("claw_e2ee_v1");
    expect(envelope.ciphertext).not.toContain("hello peer");

    const decrypted = await beta.decryptInbound({
      fromAgentDid: ALPHA_DID,
      toAgentDid: BETA_DID,
      payload: envelope,
    });

    expect(decrypted).toEqual(plaintext);
  });

  it("rejects outbound encryption when peer e2ee metadata is missing", async () => {
    const configDir = await createTempConfigDir();
    const logger = createLogger({ service: "test", module: "e2ee" });
    const manager = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });

    await manager.initialize();
    await writeFile(
      join(configDir, "peers.json"),
      `${JSON.stringify(
        {
          peers: {
            beta: {
              did: BETA_DID,
              proxyUrl: "https://beta.proxy.example/hooks/agent",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(
      manager.encryptOutbound({
        peerAlias: "beta",
        peerDid: BETA_DID,
        payload: { message: "hello" },
      }),
    ).rejects.toMatchObject({
      code: "CONNECTOR_E2EE_PEER_NOT_FOUND",
    });
  });

  it("recreates outbound session when peer key id changes", async () => {
    const configDir = await createTempConfigDir();
    const logger = createLogger({ service: "test", module: "e2ee" });
    const alpha = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });
    const beta = new ConnectorE2eeManager({
      agentDid: BETA_DID,
      agentName: "beta",
      configDir,
      logger,
    });

    await alpha.initialize();
    await beta.initialize();

    const alphaIdentity = await readIdentity({ configDir, agentName: "alpha" });
    const betaIdentity = await readIdentity({ configDir, agentName: "beta" });

    await writeFile(
      join(configDir, "peers.json"),
      `${JSON.stringify(
        {
          peers: {
            beta: {
              did: BETA_DID,
              proxyUrl: "https://beta.proxy.example/hooks/agent",
              e2ee: {
                keyId: betaIdentity.keyId,
                x25519PublicKey: betaIdentity.x25519PublicKey,
              },
            },
            alpha: {
              did: ALPHA_DID,
              proxyUrl: "https://alpha.proxy.example/hooks/agent",
              e2ee: {
                keyId: alphaIdentity.keyId,
                x25519PublicKey: alphaIdentity.x25519PublicKey,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await alpha.encryptOutbound({
      peerAlias: "beta",
      peerDid: BETA_DID,
      payload: { message: "first" },
    });
    const firstSession = await readSession({
      configDir,
      agentName: "alpha",
      peerDid: BETA_DID,
    });

    await writeFile(
      join(configDir, "peers.json"),
      `${JSON.stringify(
        {
          peers: {
            beta: {
              did: BETA_DID,
              proxyUrl: "https://beta.proxy.example/hooks/agent",
              e2ee: {
                keyId: "beta-key-rotated",
                x25519PublicKey: betaIdentity.x25519PublicKey,
              },
            },
            alpha: {
              did: ALPHA_DID,
              proxyUrl: "https://alpha.proxy.example/hooks/agent",
              e2ee: {
                keyId: alphaIdentity.keyId,
                x25519PublicKey: alphaIdentity.x25519PublicKey,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const second = await alpha.encryptOutbound({
      peerAlias: "beta",
      peerDid: BETA_DID,
      payload: { message: "second" },
    });
    const secondSession = await readSession({
      configDir,
      agentName: "alpha",
      peerDid: BETA_DID,
    });

    expect(first.counter).toBe(0);
    expect(second.counter).toBe(0);
    expect(firstSession?.sessionId).toBeDefined();
    expect(secondSession?.sessionId).toBeDefined();
    expect(secondSession?.sessionId).not.toBe(firstSession?.sessionId);
    expect(secondSession?.peerKeyId).toBe("beta-key-rotated");
  });

  it("recreates outbound session when local key id changes", async () => {
    const configDir = await createTempConfigDir();
    const logger = createLogger({ service: "test", module: "e2ee" });
    const alpha = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });
    const beta = new ConnectorE2eeManager({
      agentDid: BETA_DID,
      agentName: "beta",
      configDir,
      logger,
    });

    await alpha.initialize();
    await beta.initialize();

    const alphaIdentity = await readIdentity({ configDir, agentName: "alpha" });
    const betaIdentity = await readIdentity({ configDir, agentName: "beta" });

    await writeFile(
      join(configDir, "peers.json"),
      `${JSON.stringify(
        {
          peers: {
            beta: {
              did: BETA_DID,
              proxyUrl: "https://beta.proxy.example/hooks/agent",
              e2ee: {
                keyId: betaIdentity.keyId,
                x25519PublicKey: betaIdentity.x25519PublicKey,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const first = await alpha.encryptOutbound({
      peerAlias: "beta",
      peerDid: BETA_DID,
      payload: { message: "first" },
    });
    const firstSession = await readSession({
      configDir,
      agentName: "alpha",
      peerDid: BETA_DID,
    });

    await writeFile(
      join(configDir, "agents", "alpha", "e2ee-identity.json"),
      `${JSON.stringify(
        {
          version: 1,
          keyId: "alpha-key-rotated",
          x25519PublicKey: alphaIdentity.x25519PublicKey,
          x25519SecretKey: alphaIdentity.x25519SecretKey,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const alphaAfterIdentityChange = new ConnectorE2eeManager({
      agentDid: ALPHA_DID,
      agentName: "alpha",
      configDir,
      logger,
    });
    await alphaAfterIdentityChange.initialize();

    const second = await alphaAfterIdentityChange.encryptOutbound({
      peerAlias: "beta",
      peerDid: BETA_DID,
      payload: { message: "second" },
    });
    const secondSession = await readSession({
      configDir,
      agentName: "alpha",
      peerDid: BETA_DID,
    });

    expect(first.counter).toBe(0);
    expect(second.counter).toBe(0);
    expect(firstSession?.sessionId).toBeDefined();
    expect(secondSession?.sessionId).toBeDefined();
    expect(secondSession?.sessionId).not.toBe(firstSession?.sessionId);
    expect(secondSession?.localKeyId).toBe("alpha-key-rotated");
  });
});
