import type { CliConfig, getConfigDir } from "../../config/manager.js";

export type PairStartOptions = {
  ttlSeconds?: string;
  qr?: boolean;
  qrOutput?: string;
  wait?: boolean;
  waitSeconds?: string;
  pollIntervalSeconds?: string;
};

export type PairConfirmOptions = {
  qrFile?: string;
  ticket?: string;
};

export type PairStatusOptions = {
  ticket?: string;
  wait?: boolean;
  waitSeconds?: string;
  pollIntervalSeconds?: string;
};

export type PairRequestOptions = {
  fetchImpl?: typeof fetch;
  getConfigDirImpl?: typeof getConfigDir;
  nowSecondsImpl?: () => number;
  nonceFactoryImpl?: () => string;
  readFileImpl?: typeof import("node:fs/promises").readFile;
  writeFileImpl?: typeof import("node:fs/promises").writeFile;
  chmodImpl?: typeof import("node:fs/promises").chmod;
  mkdirImpl?: typeof import("node:fs/promises").mkdir;
  readdirImpl?: typeof import("node:fs/promises").readdir;
  unlinkImpl?: typeof import("node:fs/promises").unlink;
  sleepImpl?: (ms: number) => Promise<void>;
  resolveConfigImpl?: () => Promise<CliConfig>;
  qrEncodeImpl?: (ticket: string) => Promise<Uint8Array>;
  qrDecodeImpl?: (imageBytes: Uint8Array) => string;
};

export type PairCommandDependencies = PairRequestOptions;

export type PeerEntry = {
  did: string;
  proxyUrl: string;
  agentName?: string;
  humanName?: string;
};

export type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

export type PeerProfile = {
  agentName: string;
  humanName: string;
  proxyOrigin?: string;
};

export type PairStartResult = {
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  ticket: string;
  expiresAt: string;
  proxyUrl: string;
  qrPath?: string;
};

export type PairConfirmResult = {
  paired: boolean;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  proxyUrl: string;
  peerAlias?: string;
};

export type PairStatusResult = {
  status: "pending" | "confirmed";
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid?: string;
  responderProfile?: PeerProfile;
  expiresAt: string;
  confirmedAt?: string;
  proxyUrl: string;
  peerAlias?: string;
};

export type LocalAgentProofMaterial = {
  ait: string;
  secretKey: Uint8Array;
};

export type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};
