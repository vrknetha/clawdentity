import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  decodeBase64url,
  type EncryptedRelayPayloadV1,
  encodeBase64url,
  generateUlid,
  parseEncryptedRelayPayloadV1,
} from "@clawdentity/protocol";
import {
  AppError,
  decodeCanonicalJson,
  decryptXChaCha20Poly1305,
  deriveX25519SharedSecret,
  encodeCanonicalJson,
  encodeX25519KeypairBase64url,
  encryptXChaCha20Poly1305,
  generateX25519Keypair,
  hkdfSha256,
  type Logger,
  sha256,
  zeroBytes,
} from "@clawdentity/sdk";

const AGENTS_DIR_NAME = "agents";
const PEERS_FILE_NAME = "peers.json";
const E2EE_IDENTITY_FILE_NAME = "e2ee-identity.json";
const E2EE_SESSIONS_FILE_NAME = "e2ee-sessions.json";
const E2EE_IDENTITY_VERSION = 1;
const E2EE_SESSIONS_VERSION = 1;
const X25519_KEY_BYTES = 32;
const XCHACHA20_NONCE_BYTES = 24;
const SESSION_REKEY_MAX_MESSAGES = 100;
const SESSION_REKEY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INFO_ROOT_V1 = "claw/e2ee/root/v1";
const INFO_CHAIN_AB_V1 = "claw/e2ee/chain/ab/v1";
const INFO_CHAIN_BA_V1 = "claw/e2ee/chain/ba/v1";
const INFO_CHAIN_NEXT_V1 = "claw/e2ee/chain/next/v1";

type StoredE2eeIdentity = {
  version: number;
  keyId: string;
  x25519PublicKey: string;
  x25519SecretKey: string;
};

type StoredE2eeSession = {
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

type StoredE2eeSessionsFile = {
  version: number;
  sessionsByPeerDid: Record<string, StoredE2eeSession>;
};

type PeerE2eeBundle = {
  did: string;
  keyId: string;
  x25519PublicKey: string;
};

type PeerConfigEntry = {
  did?: unknown;
  e2ee?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertDidEquals(
  expectedDid: string,
  actualDid: string,
  label: string,
): void {
  if (expectedDid !== actualDid) {
    throw new AppError({
      code: "CONNECTOR_E2EE_PEER_DID_MISMATCH",
      message: `${label} does not match configured peer DID`,
      status: 400,
      expose: true,
    });
  }
}

function parseBase64Key(
  value: string,
  expectedBytes: number,
  code: string,
  message: string,
): Uint8Array {
  try {
    const decoded = decodeBase64url(value);
    if (decoded.length !== expectedBytes) {
      throw new Error("invalid length");
    }
    return decoded;
  } catch {
    throw new AppError({
      code,
      message,
      status: 400,
      expose: true,
    });
  }
}

function normalizePeerE2eeBundle(
  value: unknown,
  did: string,
): PeerE2eeBundle | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const keyId =
    typeof value.keyId === "string" ? value.keyId.trim() : undefined;
  const x25519PublicKey =
    typeof value.x25519PublicKey === "string"
      ? value.x25519PublicKey.trim()
      : undefined;

  if (!keyId || !x25519PublicKey) {
    return undefined;
  }

  try {
    if (decodeBase64url(x25519PublicKey).length !== X25519_KEY_BYTES) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    did,
    keyId,
    x25519PublicKey,
  };
}

async function writeJsonAtomic(
  targetPath: string,
  payload: unknown,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

function toAad(input: {
  fromAgentDid: string;
  toAgentDid: string;
  sessionId: string;
  epoch: number;
  counter: number;
  sentAt: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      input.fromAgentDid,
      input.toAgentDid,
      input.sessionId,
      String(input.epoch),
      String(input.counter),
      input.sentAt,
    ].join("|"),
  );
}

function toChainInfo(
  localDid: string,
  peerDid: string,
): {
  sendInfo: Uint8Array;
  recvInfo: Uint8Array;
} {
  const localFirst = localDid.localeCompare(peerDid) < 0;
  return {
    sendInfo: new TextEncoder().encode(
      localFirst ? INFO_CHAIN_AB_V1 : INFO_CHAIN_BA_V1,
    ),
    recvInfo: new TextEncoder().encode(
      localFirst ? INFO_CHAIN_BA_V1 : INFO_CHAIN_AB_V1,
    ),
  };
}

function toNextChainInfo(): Uint8Array {
  return new TextEncoder().encode(INFO_CHAIN_NEXT_V1);
}

function toEpochInfo(epoch: number): Uint8Array {
  return new TextEncoder().encode(`claw/e2ee/epoch/v1/${epoch}`);
}

function toMessageInfo(epoch: number, counter: number): Uint8Array {
  return new TextEncoder().encode(`claw/e2ee/msg/v1/${epoch}/${counter}`);
}

async function deriveDirectionalChains(input: {
  rootKey: Uint8Array;
  localDid: string;
  peerDid: string;
}): Promise<{ sendChainKey: Uint8Array; recvChainKey: Uint8Array }> {
  const infos = toChainInfo(input.localDid, input.peerDid);
  const sendChainKey = await hkdfSha256({
    ikm: input.rootKey,
    salt: zeroBytes(32),
    info: infos.sendInfo,
    length: 32,
  });
  const recvChainKey = await hkdfSha256({
    ikm: input.rootKey,
    salt: zeroBytes(32),
    info: infos.recvInfo,
    length: 32,
  });
  return {
    sendChainKey,
    recvChainKey,
  };
}

async function deriveInitialRootKey(input: {
  localDid: string;
  peerDid: string;
  localSecretKey: Uint8Array;
  peerPublicKey: Uint8Array;
}): Promise<Uint8Array> {
  const sharedSecret = deriveX25519SharedSecret(
    input.localSecretKey,
    input.peerPublicKey,
  );
  const ordered =
    input.localDid.localeCompare(input.peerDid) < 0
      ? `${input.localDid}|${input.peerDid}`
      : `${input.peerDid}|${input.localDid}`;
  const salt = await sha256(new TextEncoder().encode(ordered));
  return hkdfSha256({
    ikm: sharedSecret,
    salt,
    info: new TextEncoder().encode(INFO_ROOT_V1),
    length: 32,
  });
}

export class ConnectorE2eeManager {
  private readonly agentDid: string;
  private readonly agentName: string;
  private readonly configDir: string;
  private readonly logger: Logger;
  private readonly nowMs: () => number;
  private readonly identityPath: string;
  private readonly sessionsPath: string;
  private readonly peersPath: string;
  private identity?: StoredE2eeIdentity;
  private sessionsByPeerDid: Record<string, StoredE2eeSession> = {};

  constructor(input: {
    agentDid: string;
    agentName: string;
    configDir: string;
    logger: Logger;
    nowMs?: () => number;
  }) {
    this.agentDid = input.agentDid;
    this.agentName = input.agentName;
    this.configDir = input.configDir;
    this.logger = input.logger;
    this.nowMs = input.nowMs ?? Date.now;
    this.identityPath = join(
      this.configDir,
      AGENTS_DIR_NAME,
      this.agentName,
      E2EE_IDENTITY_FILE_NAME,
    );
    this.sessionsPath = join(
      this.configDir,
      AGENTS_DIR_NAME,
      this.agentName,
      E2EE_SESSIONS_FILE_NAME,
    );
    this.peersPath = join(this.configDir, PEERS_FILE_NAME);
  }

  async initialize(): Promise<void> {
    this.identity = await this.loadOrCreateIdentity();
    this.sessionsByPeerDid = await this.loadSessions();
  }

  async encryptOutbound(input: {
    peerAlias: string;
    peerDid: string;
    payload: unknown;
  }): Promise<EncryptedRelayPayloadV1> {
    const identity = this.requireIdentity();
    const peer = await this.resolvePeerByAlias(input.peerAlias);
    assertDidEquals(input.peerDid, peer.did, "Outbound peer DID");

    let session = await this.getOrCreateSession({
      peerDid: peer.did,
      peerKeyId: peer.keyId,
      peerPublicKey: parseBase64Key(
        peer.x25519PublicKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_PEER_KEY_INVALID",
        "Peer E2EE public key is invalid",
      ),
    });

    let rekeyPublicKey: string | undefined;
    const shouldRekey =
      session.sendCounter >= SESSION_REKEY_MAX_MESSAGES ||
      this.nowMs() - session.epochStartedAtMs >= SESSION_REKEY_MAX_AGE_MS;
    if (shouldRekey) {
      const outboundRekey = await this.rekeyOutbound({
        session,
        peerDid: peer.did,
        peerPublicKey: parseBase64Key(
          peer.x25519PublicKey,
          X25519_KEY_BYTES,
          "CONNECTOR_E2EE_PEER_KEY_INVALID",
          "Peer E2EE public key is invalid",
        ),
      });
      session = outboundRekey.session;
      rekeyPublicKey = outboundRekey.rekeyPublicKey;
    }

    const counter = session.sendCounter;
    const sentAt = new Date(this.nowMs()).toISOString();
    const nonce = randomBytes(XCHACHA20_NONCE_BYTES);
    const messageKey = await hkdfSha256({
      ikm: parseBase64Key(
        session.sendChainKey,
        32,
        "CONNECTOR_E2EE_SESSION_INVALID",
        "E2EE session state is invalid",
      ),
      salt: nonce,
      info: toMessageInfo(session.epoch, counter),
      length: 32,
    });
    const aad = toAad({
      fromAgentDid: this.agentDid,
      toAgentDid: peer.did,
      sessionId: session.sessionId,
      epoch: session.epoch,
      counter,
      sentAt,
    });
    const plaintext = encodeCanonicalJson(input.payload);
    const ciphertext = encryptXChaCha20Poly1305({
      key: messageKey,
      nonce,
      plaintext,
      aad,
    });
    const nextChainKey = await hkdfSha256({
      ikm: parseBase64Key(
        session.sendChainKey,
        32,
        "CONNECTOR_E2EE_SESSION_INVALID",
        "E2EE session state is invalid",
      ),
      salt: zeroBytes(32),
      info: toNextChainInfo(),
      length: 32,
    });
    session.sendCounter += 1;
    session.sendChainKey = encodeBase64url(nextChainKey);
    this.sessionsByPeerDid[peer.did] = session;
    await this.saveSessions();

    return {
      kind: "claw_e2ee_v1",
      alg: "X25519_XCHACHA20POLY1305_HKDF_SHA256",
      sessionId: session.sessionId,
      epoch: session.epoch,
      counter,
      nonce: encodeBase64url(nonce),
      ciphertext: encodeBase64url(ciphertext),
      senderE2eePub: identity.x25519PublicKey,
      rekeyPublicKey,
      sentAt,
    };
  }

  async decryptInbound(input: {
    fromAgentDid: string;
    toAgentDid: string;
    payload: unknown;
  }): Promise<unknown> {
    this.requireIdentity();
    assertDidEquals(this.agentDid, input.toAgentDid, "Inbound recipient DID");

    let envelope: EncryptedRelayPayloadV1;
    try {
      envelope = parseEncryptedRelayPayloadV1(input.payload);
    } catch {
      throw new AppError({
        code: "CONNECTOR_E2EE_INVALID_PAYLOAD",
        message: "Inbound payload is not a valid E2EE envelope",
        status: 400,
        expose: true,
      });
    }

    const peer = await this.resolvePeerByDid(input.fromAgentDid);
    if (peer.x25519PublicKey !== envelope.senderE2eePub) {
      throw new AppError({
        code: "CONNECTOR_E2EE_PEER_KEY_MISMATCH",
        message: "Inbound sender E2EE key does not match configured peer key",
        status: 400,
        expose: true,
      });
    }

    let session = await this.getOrCreateSession({
      peerDid: peer.did,
      peerKeyId: peer.keyId,
      peerPublicKey: parseBase64Key(
        peer.x25519PublicKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_PEER_KEY_INVALID",
        "Peer E2EE public key is invalid",
      ),
    });

    if (envelope.epoch > session.epoch) {
      if (envelope.epoch !== session.epoch + 1 || !envelope.rekeyPublicKey) {
        throw new AppError({
          code: "CONNECTOR_E2EE_REKEY_REQUIRED",
          message:
            "Inbound envelope requires missing or invalid rekey metadata",
          status: 400,
          expose: true,
        });
      }
      session = await this.rekeyInbound({
        session,
        peerDid: peer.did,
        rekeyPublicKey: envelope.rekeyPublicKey,
        nextEpoch: envelope.epoch,
      });
    }

    if (envelope.epoch < session.epoch) {
      throw new AppError({
        code: "CONNECTOR_E2EE_REPLAY_DETECTED",
        message: "Inbound envelope epoch is stale",
        status: 400,
        expose: true,
      });
    }

    if (envelope.counter !== session.recvCounter) {
      throw new AppError({
        code: "CONNECTOR_E2EE_COUNTER_MISMATCH",
        message: "Inbound envelope counter is out of sequence",
        status: 400,
        expose: true,
      });
    }

    const nonce = parseBase64Key(
      envelope.nonce,
      XCHACHA20_NONCE_BYTES,
      "CONNECTOR_E2EE_INVALID_PAYLOAD",
      "Inbound envelope nonce is invalid",
    );
    let ciphertext: Uint8Array;
    try {
      ciphertext = decodeBase64url(envelope.ciphertext);
    } catch {
      throw new AppError({
        code: "CONNECTOR_E2EE_INVALID_PAYLOAD",
        message: "Inbound envelope ciphertext is invalid",
        status: 400,
        expose: true,
      });
    }
    const recvChainKey = parseBase64Key(
      session.recvChainKey,
      32,
      "CONNECTOR_E2EE_SESSION_INVALID",
      "E2EE session state is invalid",
    );
    const messageKey = await hkdfSha256({
      ikm: recvChainKey,
      salt: nonce,
      info: toMessageInfo(session.epoch, envelope.counter),
      length: 32,
    });
    const aad = toAad({
      fromAgentDid: input.fromAgentDid,
      toAgentDid: input.toAgentDid,
      sessionId: envelope.sessionId,
      epoch: envelope.epoch,
      counter: envelope.counter,
      sentAt: envelope.sentAt,
    });

    let plaintext: Uint8Array;
    try {
      plaintext = decryptXChaCha20Poly1305({
        key: messageKey,
        nonce,
        ciphertext,
        aad,
      });
    } catch {
      throw new AppError({
        code: "CONNECTOR_E2EE_DECRYPT_FAILED",
        message: "Inbound envelope decryption failed",
        status: 400,
        expose: true,
      });
    }

    const nextChainKey = await hkdfSha256({
      ikm: recvChainKey,
      salt: zeroBytes(32),
      info: toNextChainInfo(),
      length: 32,
    });
    session.recvCounter += 1;
    session.recvChainKey = encodeBase64url(nextChainKey);
    this.sessionsByPeerDid[peer.did] = session;
    await this.saveSessions();

    return decodeCanonicalJson(plaintext);
  }

  private requireIdentity(): StoredE2eeIdentity {
    if (!this.identity) {
      throw new Error("E2EE manager is not initialized");
    }
    return this.identity;
  }

  private async loadOrCreateIdentity(): Promise<StoredE2eeIdentity> {
    try {
      const raw = await readFile(this.identityPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        throw new Error("invalid identity");
      }
      const keyId =
        typeof parsed.keyId === "string" ? parsed.keyId.trim() : undefined;
      const x25519PublicKey =
        typeof parsed.x25519PublicKey === "string"
          ? parsed.x25519PublicKey.trim()
          : undefined;
      const x25519SecretKey =
        typeof parsed.x25519SecretKey === "string"
          ? parsed.x25519SecretKey.trim()
          : undefined;
      if (!keyId || !x25519PublicKey || !x25519SecretKey) {
        throw new Error("invalid identity");
      }
      parseBase64Key(
        x25519PublicKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_IDENTITY_INVALID",
        "Local E2EE identity is invalid",
      );
      parseBase64Key(
        x25519SecretKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_IDENTITY_INVALID",
        "Local E2EE identity is invalid",
      );

      return {
        version:
          typeof parsed.version === "number"
            ? parsed.version
            : E2EE_IDENTITY_VERSION,
        keyId,
        x25519PublicKey,
        x25519SecretKey,
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }

    const generated = generateX25519Keypair();
    const encoded = encodeX25519KeypairBase64url(generated);
    const identity: StoredE2eeIdentity = {
      version: E2EE_IDENTITY_VERSION,
      keyId: generateUlid(this.nowMs()),
      x25519PublicKey: encoded.publicKey,
      x25519SecretKey: encoded.secretKey,
    };
    await writeJsonAtomic(this.identityPath, identity);
    this.logger.info("connector.e2ee.identity_created", {
      agentDid: this.agentDid,
      keyId: identity.keyId,
    });
    return identity;
  }

  private async loadSessions(): Promise<Record<string, StoredE2eeSession>> {
    try {
      const raw = await readFile(this.sessionsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return {};
      }
      const sessionsByPeerDidRaw = parsed.sessionsByPeerDid;
      if (!isRecord(sessionsByPeerDidRaw)) {
        return {};
      }

      const normalized: Record<string, StoredE2eeSession> = {};
      for (const [peerDid, value] of Object.entries(sessionsByPeerDidRaw)) {
        if (!isRecord(value)) {
          continue;
        }
        const candidate = value as Record<string, unknown>;
        if (
          typeof candidate.sessionId !== "string" ||
          typeof candidate.peerDid !== "string" ||
          typeof candidate.peerKeyId !== "string" ||
          typeof candidate.localKeyId !== "string" ||
          typeof candidate.epoch !== "number" ||
          typeof candidate.epochStartedAtMs !== "number" ||
          typeof candidate.sendCounter !== "number" ||
          typeof candidate.recvCounter !== "number" ||
          typeof candidate.rootKey !== "string" ||
          typeof candidate.sendChainKey !== "string" ||
          typeof candidate.recvChainKey !== "string"
        ) {
          continue;
        }
        normalized[peerDid] = {
          sessionId: candidate.sessionId,
          peerDid: candidate.peerDid,
          peerKeyId: candidate.peerKeyId,
          localKeyId: candidate.localKeyId,
          epoch: candidate.epoch,
          epochStartedAtMs: candidate.epochStartedAtMs,
          sendCounter: candidate.sendCounter,
          recvCounter: candidate.recvCounter,
          rootKey: candidate.rootKey,
          sendChainKey: candidate.sendChainKey,
          recvChainKey: candidate.recvChainKey,
        };
      }
      return normalized;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async saveSessions(): Promise<void> {
    const payload: StoredE2eeSessionsFile = {
      version: E2EE_SESSIONS_VERSION,
      sessionsByPeerDid: this.sessionsByPeerDid,
    };
    await writeJsonAtomic(this.sessionsPath, payload);
  }

  private async resolvePeerByAlias(alias: string): Promise<PeerE2eeBundle> {
    const peers = await this.loadPeers();
    const peer = peers.byAlias[alias];
    if (!peer) {
      throw new AppError({
        code: "CONNECTOR_E2EE_PEER_NOT_FOUND",
        message: `Peer alias "${alias}" is missing an E2EE configuration`,
        status: 400,
        expose: true,
      });
    }
    return peer;
  }

  private async resolvePeerByDid(did: string): Promise<PeerE2eeBundle> {
    const peers = await this.loadPeers();
    const peer = peers.byDid[did];
    if (!peer) {
      throw new AppError({
        code: "CONNECTOR_E2EE_PEER_NOT_FOUND",
        message: `Peer DID "${did}" is missing an E2EE configuration`,
        status: 400,
        expose: true,
      });
    }
    return peer;
  }

  private async loadPeers(): Promise<{
    byAlias: Record<string, PeerE2eeBundle>;
    byDid: Record<string, PeerE2eeBundle>;
  }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.peersPath, "utf8"));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return { byAlias: {}, byDid: {} };
      }
      throw error;
    }
    if (!isRecord(parsed) || !isRecord(parsed.peers)) {
      return { byAlias: {}, byDid: {} };
    }

    const byAlias: Record<string, PeerE2eeBundle> = {};
    const byDid: Record<string, PeerE2eeBundle> = {};
    for (const [alias, rawPeer] of Object.entries(parsed.peers)) {
      if (!isRecord(rawPeer)) {
        continue;
      }
      const peerEntry = rawPeer as PeerConfigEntry;
      const did = typeof peerEntry.did === "string" ? peerEntry.did.trim() : "";
      if (!did) {
        continue;
      }
      const bundle = normalizePeerE2eeBundle(peerEntry.e2ee, did);
      if (!bundle) {
        continue;
      }
      byAlias[alias] = bundle;
      byDid[bundle.did] = bundle;
    }

    return { byAlias, byDid };
  }

  private async getOrCreateSession(input: {
    peerDid: string;
    peerKeyId: string;
    peerPublicKey: Uint8Array;
  }): Promise<StoredE2eeSession> {
    const identity = this.requireIdentity();
    const existing = this.sessionsByPeerDid[input.peerDid];
    if (
      existing &&
      existing.peerKeyId === input.peerKeyId &&
      existing.localKeyId === identity.keyId
    ) {
      return existing;
    }

    const rootKey = await deriveInitialRootKey({
      localDid: this.agentDid,
      peerDid: input.peerDid,
      localSecretKey: parseBase64Key(
        identity.x25519SecretKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_IDENTITY_INVALID",
        "Local E2EE identity is invalid",
      ),
      peerPublicKey: input.peerPublicKey,
    });
    const chains = await deriveDirectionalChains({
      rootKey,
      localDid: this.agentDid,
      peerDid: input.peerDid,
    });
    const created: StoredE2eeSession = {
      sessionId: generateUlid(this.nowMs()),
      peerDid: input.peerDid,
      peerKeyId: input.peerKeyId,
      localKeyId: identity.keyId,
      epoch: 1,
      epochStartedAtMs: this.nowMs(),
      sendCounter: 0,
      recvCounter: 0,
      rootKey: encodeBase64url(rootKey),
      sendChainKey: encodeBase64url(chains.sendChainKey),
      recvChainKey: encodeBase64url(chains.recvChainKey),
    };

    if (existing) {
      this.logger.info("connector.e2ee.session_recreated", {
        peerDid: input.peerDid,
        previousSessionId: existing.sessionId,
        previousPeerKeyId: existing.peerKeyId,
        previousLocalKeyId: existing.localKeyId,
        nextPeerKeyId: input.peerKeyId,
        nextLocalKeyId: identity.keyId,
      });
    }

    this.sessionsByPeerDid[input.peerDid] = created;
    await this.saveSessions();
    return created;
  }

  private async rekeyOutbound(input: {
    session: StoredE2eeSession;
    peerDid: string;
    peerPublicKey: Uint8Array;
  }): Promise<{ session: StoredE2eeSession; rekeyPublicKey: string }> {
    const ephemeral = generateX25519Keypair();
    const epochSecret = deriveX25519SharedSecret(
      ephemeral.secretKey,
      input.peerPublicKey,
    );
    const nextEpoch = input.session.epoch + 1;
    const newRootKey = await hkdfSha256({
      ikm: epochSecret,
      salt: parseBase64Key(
        input.session.rootKey,
        32,
        "CONNECTOR_E2EE_SESSION_INVALID",
        "E2EE session state is invalid",
      ),
      info: toEpochInfo(nextEpoch),
      length: 32,
    });
    const chains = await deriveDirectionalChains({
      rootKey: newRootKey,
      localDid: this.agentDid,
      peerDid: input.peerDid,
    });

    const nextSession: StoredE2eeSession = {
      ...input.session,
      epoch: nextEpoch,
      epochStartedAtMs: this.nowMs(),
      sendCounter: 0,
      recvCounter: 0,
      rootKey: encodeBase64url(newRootKey),
      sendChainKey: encodeBase64url(chains.sendChainKey),
      recvChainKey: encodeBase64url(chains.recvChainKey),
    };
    this.sessionsByPeerDid[input.peerDid] = nextSession;
    await this.saveSessions();
    return {
      session: nextSession,
      rekeyPublicKey: encodeBase64url(ephemeral.publicKey),
    };
  }

  private async rekeyInbound(input: {
    session: StoredE2eeSession;
    peerDid: string;
    rekeyPublicKey: string;
    nextEpoch: number;
  }): Promise<StoredE2eeSession> {
    const identity = this.requireIdentity();
    const epochSecret = deriveX25519SharedSecret(
      parseBase64Key(
        identity.x25519SecretKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_IDENTITY_INVALID",
        "Local E2EE identity is invalid",
      ),
      parseBase64Key(
        input.rekeyPublicKey,
        X25519_KEY_BYTES,
        "CONNECTOR_E2EE_REKEY_REQUIRED",
        "Inbound rekey public key is invalid",
      ),
    );
    const newRootKey = await hkdfSha256({
      ikm: epochSecret,
      salt: parseBase64Key(
        input.session.rootKey,
        32,
        "CONNECTOR_E2EE_SESSION_INVALID",
        "E2EE session state is invalid",
      ),
      info: toEpochInfo(input.nextEpoch),
      length: 32,
    });
    const chains = await deriveDirectionalChains({
      rootKey: newRootKey,
      localDid: this.agentDid,
      peerDid: input.peerDid,
    });
    const nextSession: StoredE2eeSession = {
      ...input.session,
      epoch: input.nextEpoch,
      epochStartedAtMs: this.nowMs(),
      sendCounter: 0,
      recvCounter: 0,
      rootKey: encodeBase64url(newRootKey),
      sendChainKey: encodeBase64url(chains.sendChainKey),
      recvChainKey: encodeBase64url(chains.recvChainKey),
    };
    this.sessionsByPeerDid[input.peerDid] = nextSession;
    await this.saveSessions();
    return nextSession;
  }
}
