import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeBase64url,
  encodeBase64url,
  parseDid,
} from "@clawdentity/protocol";
import { AppError, createLogger, nowIso } from "@clawdentity/sdk";
import { Command } from "commander";
import { getConfigDir, resolveConfig } from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { installConnectorServiceForAgent } from "./connector.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "openclaw" });

const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const PEERS_FILE_NAME = "peers.json";
const OPENCLAW_DIR_NAME = ".openclaw";
const OPENCLAW_CONFIG_FILE_NAME = "openclaw.json";
const LEGACY_OPENCLAW_STATE_DIR_NAMES = [
  ".clawdbot",
  ".moldbot",
  ".moltbot",
] as const;
const LEGACY_OPENCLAW_CONFIG_FILE_NAMES = [
  "clawdbot.json",
  "moldbot.json",
  "moltbot.json",
] as const;
const OPENCLAW_AGENT_FILE_NAME = "openclaw-agent-name";
const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
const OPENCLAW_CONNECTORS_FILE_NAME = "openclaw-connectors.json";
const SKILL_DIR_NAME = "clawdentity-openclaw-relay";
const RELAY_MODULE_FILE_NAME = "relay-to-peer.mjs";
const RELAY_RUNTIME_FILE_NAME = "clawdentity-relay.json";
const RELAY_PEERS_FILE_NAME = "clawdentity-peers.json";
const HOOK_MAPPING_ID = "clawdentity-send-to-peer";
const HOOK_PATH_SEND_TO_PEER = "send-to-peer";
const OPENCLAW_SEND_TO_PEER_HOOK_PATH = "hooks/send-to-peer";
const DEFAULT_OPENCLAW_BASE_URL = "http://127.0.0.1:18789";
const DEFAULT_OPENCLAW_MAIN_SESSION_KEY = "main";
const DEFAULT_CONNECTOR_PORT = 19400;
const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";
const DEFAULT_CONNECTOR_STATUS_PATH = "/v1/status";
const DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS = 30;
const CONNECTOR_HOST_LOOPBACK = "127.0.0.1";
const CONNECTOR_HOST_DOCKER = "host.docker.internal";
const CONNECTOR_HOST_DOCKER_GATEWAY = "gateway.docker.internal";
const CONNECTOR_HOST_LINUX_BRIDGE = "172.17.0.1";
const CONNECTOR_RUN_DIR_NAME = "run";
const CONNECTOR_DETACHED_STDOUT_FILE_SUFFIX = "stdout.log";
const CONNECTOR_DETACHED_STDERR_FILE_SUFFIX = "stderr.log";
const INVITE_CODE_PREFIX = "clawd1_";
const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
const FILE_MODE = 0o600;
const OPENCLAW_HOOK_TOKEN_BYTES = 32;
const OPENCLAW_SETUP_COMMAND_HINT =
  "Run: clawdentity openclaw setup <agentName>";
const OPENCLAW_SETUP_RESTART_COMMAND_HINT = `${OPENCLAW_SETUP_COMMAND_HINT} and restart OpenClaw`;
const OPENCLAW_SETUP_WITH_BASE_URL_HINT = `${OPENCLAW_SETUP_COMMAND_HINT} --openclaw-base-url <url>`;
const OPENCLAW_PAIRING_COMMAND_HINT =
  "Run QR pairing first: clawdentity pair start <agentName> --qr and clawdentity pair confirm <agentName> --qr-file <path>";
const OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT =
  "Run: clawdentity openclaw setup <agentName> (auto-recovers pending OpenClaw gateway device approvals)";
const OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT =
  "Run: clawdentity openclaw setup <agentName> (ensures gateway auth mode/token are configured)";
const OPENCLAW_GATEWAY_APPROVAL_COMMAND = "openclaw";
const OPENCLAW_GATEWAY_APPROVAL_TIMEOUT_MS = 10_000;
const OPENCLAW_SETUP_STABILITY_WINDOW_SECONDS = 20;
const OPENCLAW_SETUP_STABILITY_POLL_INTERVAL_MS = 1_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type OpenclawInvitePayload = {
  v: 1;
  issuedAt: string;
  did: string;
  proxyUrl: string;
  alias?: string;
  agentName?: string;
  humanName?: string;
};

type OpenclawInviteOptions = {
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  agentName?: string;
  humanName?: string;
};

type OpenclawSetupOptions = {
  inviteCode?: string;
  openclawDir?: string;
  transformSource?: string;
  openclawBaseUrl?: string;
  runtimeMode?: string;
  waitTimeoutSeconds?: string;
  noRuntimeStart?: boolean;
  homeDir?: string;
  gatewayDeviceApprovalRunner?: OpenclawGatewayDeviceApprovalRunner;
};

type OpenclawDoctorOptions = {
  homeDir?: string;
  openclawDir?: string;
  peerAlias?: string;
  resolveConfigImpl?: typeof resolveConfig;
  fetchImpl?: typeof fetch;
  includeConfigCheck?: boolean;
  includeConnectorRuntimeCheck?: boolean;
  json?: boolean;
};

type OpenclawDoctorCommandOptions = {
  peer?: string;
  openclawDir?: string;
  json?: boolean;
};

type OpenclawSetupCommandOptions = {
  openclawDir?: string;
  transformSource?: string;
  openclawBaseUrl?: string;
  runtimeMode?: string;
  waitTimeoutSeconds?: string;
  noRuntimeStart?: boolean;
};

type OpenclawRelayTestOptions = {
  peer?: string;
  homeDir?: string;
  openclawDir?: string;
  openclawBaseUrl?: string;
  hookToken?: string;
  sessionId?: string;
  message?: string;
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: typeof resolveConfig;
  json?: boolean;
};

type OpenclawGatewayDeviceApprovalInput = {
  requestId: string;
  openclawDir: string;
  openclawConfigPath: string;
};

type OpenclawGatewayDeviceApprovalExecution = {
  ok: boolean;
  unavailable?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
};

type OpenclawGatewayDeviceApprovalRunner = (
  input: OpenclawGatewayDeviceApprovalInput,
) => Promise<OpenclawGatewayDeviceApprovalExecution>;

type OpenclawGatewayDeviceApprovalAttempt = {
  requestId: string;
  ok: boolean;
  unavailable: boolean;
  reason?: string;
  exitCode?: number;
};

type OpenclawGatewayDeviceApprovalSummary = {
  gatewayDevicePendingPath: string;
  pendingRequestIds: string[];
  attempts: OpenclawGatewayDeviceApprovalAttempt[];
};

type PeerEntry = {
  did: string;
  proxyUrl: string;
  agentName?: string;
  humanName?: string;
};

type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

export type OpenclawInviteResult = {
  code: string;
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  agentName?: string;
  humanName?: string;
};

export type OpenclawSetupResult = {
  openclawConfigPath: string;
  transformTargetPath: string;
  relayTransformRuntimePath: string;
  relayTransformPeersPath: string;
  openclawBaseUrl: string;
  connectorBaseUrl: string;
  relayRuntimeConfigPath: string;
  openclawConfigChanged: boolean;
};

type OpenclawRuntimeMode = "auto" | "service" | "detached";

type OpenclawRuntimeResult = {
  runtimeMode: "none" | "service" | "detached" | "existing";
  runtimeStatus: "running" | "skipped";
  websocketStatus: "connected" | "skipped";
  connectorStatusUrl?: string;
};

export type OpenclawSelfSetupResult = OpenclawSetupResult &
  OpenclawRuntimeResult;

type OpenclawRelayRuntimeConfig = {
  openclawBaseUrl: string;
  openclawHookToken?: string;
  relayTransformPeersPath?: string;
  updatedAt?: string;
};

type ConnectorAssignmentEntry = {
  connectorBaseUrl: string;
  updatedAt: string;
};

type ConnectorAssignmentsConfig = {
  agents: Record<string, ConnectorAssignmentEntry>;
};

type OpenclawDoctorCheckId =
  | "config.registry"
  | "state.selectedAgent"
  | "state.credentials"
  | "state.peers"
  | "state.transform"
  | "state.hookMapping"
  | "state.hookToken"
  | "state.hookSessionRouting"
  | "state.gatewayAuth"
  | "state.gatewayDevicePairing"
  | "state.openclawBaseUrl"
  | "state.connectorRuntime"
  | "state.connectorInboundInbox"
  | "state.openclawHookHealth";

type OpenclawDoctorCheckStatus = "pass" | "fail";

export type OpenclawDoctorCheckResult = {
  id: OpenclawDoctorCheckId;
  label: string;
  status: OpenclawDoctorCheckStatus;
  message: string;
  remediationHint?: string;
  details?: Record<string, unknown>;
};

export type OpenclawDoctorResult = {
  status: "healthy" | "unhealthy";
  checkedAt: string;
  checks: OpenclawDoctorCheckResult[];
};

export type OpenclawRelayTestResult = {
  status: "success" | "failure";
  checkedAt: string;
  peerAlias: string;
  endpoint: string;
  message: string;
  httpStatus?: number;
  remediationHint?: string;
  details?: Record<string, unknown>;
  preflight?: OpenclawDoctorResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createCliError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    code,
    message,
    status: 400,
    details,
  });
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must be a string",
      {
        label,
      },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must not be empty",
      { label },
    );
  }

  return trimmed;
}

function parseOptionalProfileName(
  value: unknown,
  label: "agentName" | "humanName",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, label);
}

function parsePeerAlias(value: unknown): string {
  const alias = parseNonEmptyString(value, "peer alias");
  if (alias.length > 128) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must be at most 128 characters",
    );
  }

  if (!PEER_ALIAS_PATTERN.test(alias)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must use only letters, numbers, dot, underscore, or hyphen",
    );
  }

  return alias;
}

function parseProxyUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "proxy URL",
    code: "CLI_OPENCLAW_INVALID_PROXY_URL",
    message: "proxy URL must be a valid URL",
  });
}

function parseHttpUrl(
  value: unknown,
  input: {
    label: string;
    code: string;
    message: string;
  },
): string {
  const candidate = parseNonEmptyString(value, input.label);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw createCliError(input.code, input.message);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createCliError(input.code, `${input.label} must use http or https`);
  }

  if (
    parsedUrl.pathname === "/" &&
    parsedUrl.search.length === 0 &&
    parsedUrl.hash.length === 0
  ) {
    return parsedUrl.origin;
  }

  return parsedUrl.toString();
}

function parseOpenclawBaseUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "OpenClaw base URL",
    code: "CLI_OPENCLAW_INVALID_OPENCLAW_BASE_URL",
    message: "OpenClaw base URL must be a valid URL",
  });
}

function parseAgentDid(value: unknown, label: string): string {
  const did = parseNonEmptyString(value, label);

  try {
    const parsed = parseDid(did);
    if (parsed.kind !== "agent") {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_DID",
        "DID is not an agent DID",
      );
    }
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_DID", "Agent DID is invalid", {
      label,
    });
  }

  return did;
}

function parseInvitePayload(value: unknown): OpenclawInvitePayload {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload must be an object",
    );
  }

  if (value.v !== 1) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload version is unsupported",
    );
  }

  const issuedAt = parseNonEmptyString(value.issuedAt, "invite issuedAt");
  const did = parseAgentDid(value.did, "invite did");
  const proxyUrl = parseProxyUrl(value.proxyUrl);
  const alias =
    value.alias === undefined ? undefined : parsePeerAlias(value.alias);
  const agentName = parseOptionalProfileName(value.agentName, "agentName");
  const humanName = parseOptionalProfileName(value.humanName, "humanName");

  if (
    alias === undefined &&
    agentName === undefined &&
    humanName === undefined
  ) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
    };
  }

  if (agentName === undefined && humanName === undefined) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
      alias,
    };
  }

  return {
    v: 1,
    issuedAt,
    did,
    proxyUrl,
    alias,
    agentName,
    humanName,
  };
}

function resolveHomeDir(homeDir?: string): string {
  if (typeof homeDir === "string" && homeDir.trim().length > 0) {
    return homeDir.trim();
  }

  return homedir();
}

function resolveHomePrefixedPath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return resolvePath(trimmed.replace(/^~(?=$|[\\/])/, homeDir));
  }
  return resolvePath(trimmed);
}

function readNonEmptyEnvPath(
  value: string | undefined,
  homeDir: string,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return resolveHomePrefixedPath(value, homeDir);
}

function resolveOpenclawHomeDir(homeDir: string): string {
  const envOpenclawHome = readNonEmptyEnvPath(
    process.env.OPENCLAW_HOME,
    homeDir,
  );
  return envOpenclawHome ?? homeDir;
}

function resolveDefaultOpenclawStateDir(openclawHomeDir: string): string {
  const newStateDir = join(openclawHomeDir, OPENCLAW_DIR_NAME);
  if (existsSync(newStateDir)) {
    return newStateDir;
  }

  for (const legacyDirName of LEGACY_OPENCLAW_STATE_DIR_NAMES) {
    const legacyStateDir = join(openclawHomeDir, legacyDirName);
    if (existsSync(legacyStateDir)) {
      return legacyStateDir;
    }
  }

  return newStateDir;
}

function resolveOpenclawDir(openclawDir: string | undefined, homeDir: string) {
  if (typeof openclawDir === "string" && openclawDir.trim().length > 0) {
    return resolveHomePrefixedPath(openclawDir, homeDir);
  }

  const envStateDir = readNonEmptyEnvPath(
    process.env.OPENCLAW_STATE_DIR ?? process.env.CLAWDBOT_STATE_DIR,
    homeDir,
  );
  if (envStateDir !== undefined) {
    return envStateDir;
  }

  const envConfigPath = readNonEmptyEnvPath(
    process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH,
    homeDir,
  );
  if (envConfigPath !== undefined) {
    return dirname(envConfigPath);
  }

  const openclawHomeDir = resolveOpenclawHomeDir(homeDir);
  return resolveDefaultOpenclawStateDir(openclawHomeDir);
}

function resolveAgentDirectory(homeDir: string, agentName: string): string {
  return join(getConfigDir({ homeDir }), AGENTS_DIR_NAME, agentName);
}

function resolvePeersPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), PEERS_FILE_NAME);
}

function resolveOpenclawConfigPath(
  openclawDir: string,
  homeDir: string,
): string {
  const envConfigPath = readNonEmptyEnvPath(
    process.env.OPENCLAW_CONFIG_PATH ?? process.env.CLAWDBOT_CONFIG_PATH,
    homeDir,
  );
  if (envConfigPath !== undefined) {
    return envConfigPath;
  }

  const configCandidates = [
    join(openclawDir, OPENCLAW_CONFIG_FILE_NAME),
    ...LEGACY_OPENCLAW_CONFIG_FILE_NAMES.map((fileName) =>
      join(openclawDir, fileName),
    ),
  ];

  for (const candidate of configCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return configCandidates[0];
}

function resolveDefaultTransformSource(openclawDir: string): string {
  return join(openclawDir, "skills", SKILL_DIR_NAME, RELAY_MODULE_FILE_NAME);
}

function resolveTransformTargetPath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_MODULE_FILE_NAME);
}

function resolveOpenclawAgentNamePath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_AGENT_FILE_NAME);
}

function resolveRelayRuntimeConfigPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_RELAY_RUNTIME_FILE_NAME);
}

function resolveConnectorAssignmentsPath(homeDir: string): string {
  return join(getConfigDir({ homeDir }), OPENCLAW_CONNECTORS_FILE_NAME);
}

function resolveTransformRuntimePath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_RUNTIME_FILE_NAME);
}

function resolveTransformPeersPath(openclawDir: string): string {
  return join(openclawDir, "hooks", "transforms", RELAY_PEERS_FILE_NAME);
}

type OpenclawGatewayPendingState =
  | {
      status: "missing";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "invalid";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "unreadable";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "ok";
      gatewayDevicePendingPath: string;
      pendingRequestIds: string[];
    };

async function readOpenclawGatewayPendingState(
  openclawDir: string,
): Promise<OpenclawGatewayPendingState> {
  const gatewayDevicePendingPath = join(openclawDir, "devices", "pending.json");
  try {
    const pendingPayload = await readJsonFile(gatewayDevicePendingPath);
    if (!isRecord(pendingPayload)) {
      return {
        status: "invalid",
        gatewayDevicePendingPath,
      };
    }
    return {
      status: "ok",
      gatewayDevicePendingPath,
      pendingRequestIds: Object.keys(pendingPayload),
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        status: "missing",
        gatewayDevicePendingPath,
      };
    }
    return {
      status: "unreadable",
      gatewayDevicePendingPath,
    };
  }
}

function resolveOpenclawGatewayApprovalCommand(): string {
  const envOverride = process.env.OPENCLAW_GATEWAY_APPROVAL_COMMAND?.trim();
  if (typeof envOverride === "string" && envOverride.length > 0) {
    return envOverride;
  }
  return OPENCLAW_GATEWAY_APPROVAL_COMMAND;
}

async function runOpenclawGatewayApprovalCommand(input: {
  command: string;
  args: string[];
  openclawDir: string;
  openclawConfigPath: string;
}): Promise<OpenclawGatewayDeviceApprovalExecution> {
  return await new Promise<OpenclawGatewayDeviceApprovalExecution>(
    (resolve) => {
      const child = spawn(input.command, input.args, {
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: input.openclawDir,
          OPENCLAW_CONFIG_PATH: input.openclawConfigPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      let stdout = "";
      let stderr = "";

      const finalize = (result: OpenclawGatewayDeviceApprovalExecution) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          ...result,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      };

      const timeout = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Best-effort timeout shutdown.
        }
        finalize({
          ok: false,
          errorMessage: `command timed out after ${OPENCLAW_GATEWAY_APPROVAL_TIMEOUT_MS}ms`,
        });
      }, OPENCLAW_GATEWAY_APPROVAL_TIMEOUT_MS);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk);
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        const errorCode = getErrorCode(error);
        finalize({
          ok: false,
          unavailable: errorCode === "ENOENT",
          errorMessage:
            error instanceof Error
              ? error.message
              : "failed to run openclaw command",
        });
      });

      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        finalize({
          ok: exitCode === 0,
          exitCode: typeof exitCode === "number" ? exitCode : undefined,
        });
      });
    },
  );
}

async function runOpenclawGatewayDeviceApproval(
  input: OpenclawGatewayDeviceApprovalInput,
): Promise<OpenclawGatewayDeviceApprovalExecution> {
  const command = resolveOpenclawGatewayApprovalCommand();
  return await runOpenclawGatewayApprovalCommand({
    command,
    args: ["devices", "approve", input.requestId, "--json"],
    openclawDir: input.openclawDir,
    openclawConfigPath: input.openclawConfigPath,
  });
}

async function autoApproveOpenclawGatewayDevices(input: {
  homeDir: string;
  openclawDir: string;
  runner?: OpenclawGatewayDeviceApprovalRunner;
}): Promise<OpenclawGatewayDeviceApprovalSummary | undefined> {
  const pendingState = await readOpenclawGatewayPendingState(input.openclawDir);
  if (
    pendingState.status !== "ok" ||
    pendingState.pendingRequestIds.length === 0
  ) {
    return undefined;
  }

  const openclawConfigPath = resolveOpenclawConfigPath(
    input.openclawDir,
    input.homeDir,
  );
  const approvalRunner = input.runner ?? runOpenclawGatewayDeviceApproval;
  const attempts: OpenclawGatewayDeviceApprovalAttempt[] = [];

  for (const requestId of pendingState.pendingRequestIds) {
    const execution = await approvalRunner({
      requestId,
      openclawDir: input.openclawDir,
      openclawConfigPath,
    });
    attempts.push({
      requestId,
      ok: execution.ok,
      unavailable: execution.unavailable === true,
      reason:
        execution.errorMessage ??
        (execution.stderr && execution.stderr.length > 0
          ? execution.stderr
          : execution.stdout && execution.stdout.length > 0
            ? execution.stdout
            : undefined),
      exitCode: execution.exitCode,
    });
    if (execution.unavailable === true) {
      break;
    }
  }

  return {
    gatewayDevicePendingPath: pendingState.gatewayDevicePendingPath,
    pendingRequestIds: pendingState.pendingRequestIds,
    attempts,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_JSON", "JSON file is invalid", {
      filePath,
    });
  }
}

async function ensureLocalAgentCredentials(
  homeDir: string,
  agentName: string,
): Promise<void> {
  const agentDir = resolveAgentDirectory(homeDir, agentName);
  const requiredFiles = [
    join(agentDir, SECRET_KEY_FILE_NAME),
    join(agentDir, AIT_FILE_NAME),
  ];

  for (const filePath of requiredFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        throw createCliError(
          "CLI_OPENCLAW_MISSING_AGENT_CREDENTIALS",
          "Local agent credentials are missing",
          { agentName, filePath },
        );
      }

      throw error;
    }

    if (content.trim().length === 0) {
      throw createCliError(
        "CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS",
        "Agent credential file is empty",
        { filePath },
      );
    }
  }
}

function encodeInvitePayload(payload: OpenclawInvitePayload): string {
  const encoded = encodeBase64url(textEncoder.encode(JSON.stringify(payload)));
  return `${INVITE_CODE_PREFIX}${encoded}`;
}

function decodeInvitePayload(code: string): OpenclawInvitePayload {
  const rawCode = parseNonEmptyString(code, "invite code");
  if (!rawCode.startsWith(INVITE_CODE_PREFIX)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "Invite code has invalid prefix",
    );
  }

  const encoded = rawCode.slice(INVITE_CODE_PREFIX.length);
  if (encoded.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is empty",
    );
  }

  let decodedJson: string;
  try {
    decodedJson = textDecoder.decode(decodeBase64url(encoded));
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid base64url",
    );
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(decodedJson);
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid JSON",
    );
  }

  return parseInvitePayload(parsedPayload);
}

async function writeSecureFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  await chmod(filePath, FILE_MODE);
}

async function loadPeersConfig(peersPath: string): Promise<PeersConfig> {
  let parsed: unknown;

  try {
    parsed = await readJsonFile(peersPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { peers: {} };
    }

    throw error;
  }

  if (!isRecord(parsed)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
      "Peer config root must be a JSON object",
      { peersPath },
    );
  }

  const peersValue = parsed.peers;
  if (peersValue === undefined) {
    return { peers: {} };
  }

  if (!isRecord(peersValue)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
      "Peer config peers field must be an object",
      { peersPath },
    );
  }

  const peers: Record<string, PeerEntry> = {};
  for (const [alias, value] of Object.entries(peersValue)) {
    const normalizedAlias = parsePeerAlias(alias);
    if (!isRecord(value)) {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_PEERS_CONFIG",
        "Peer entry must be an object",
        { alias: normalizedAlias },
      );
    }

    const did = parseAgentDid(value.did, `Peer ${normalizedAlias} did`);
    const proxyUrl = parseProxyUrl(value.proxyUrl);
    const agentName = parseOptionalProfileName(value.agentName, "agentName");
    const humanName = parseOptionalProfileName(value.humanName, "humanName");

    if (agentName === undefined && humanName === undefined) {
      peers[normalizedAlias] = { did, proxyUrl };
      continue;
    }

    peers[normalizedAlias] = { did, proxyUrl, agentName, humanName };
  }

  return { peers };
}

async function savePeersConfig(
  peersPath: string,
  config: PeersConfig,
): Promise<void> {
  await writeSecureFile(peersPath, `${JSON.stringify(config, null, 2)}\n`);
}

function parseConnectorBaseUrlForAssignment(
  value: unknown,
  label: string,
): string {
  return parseHttpUrl(value, {
    label,
    code: "CLI_OPENCLAW_INVALID_CONNECTOR_BASE_URL",
    message: "Connector base URL must be a valid URL",
  });
}

function parseConnectorAssignments(
  value: unknown,
  connectorAssignmentsPath: string,
): ConnectorAssignmentsConfig {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_CONNECTOR_ASSIGNMENTS",
      "Connector assignments config must be an object",
      { connectorAssignmentsPath },
    );
  }

  const agentsRaw = value.agents;
  if (!isRecord(agentsRaw)) {
    return { agents: {} };
  }

  const agents: Record<string, ConnectorAssignmentEntry> = {};
  for (const [agentName, entryValue] of Object.entries(agentsRaw)) {
    if (!isRecord(entryValue)) {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_CONNECTOR_ASSIGNMENTS",
        "Connector assignment entry must be an object",
        { connectorAssignmentsPath, agentName },
      );
    }

    const connectorBaseUrl = parseConnectorBaseUrlForAssignment(
      entryValue.connectorBaseUrl,
      "connectorBaseUrl",
    );
    const updatedAt =
      typeof entryValue.updatedAt === "string" &&
      entryValue.updatedAt.trim().length > 0
        ? entryValue.updatedAt.trim()
        : nowIso();

    agents[assertValidAgentName(agentName)] = {
      connectorBaseUrl,
      updatedAt,
    };
  }

  return { agents };
}

async function loadConnectorAssignments(
  connectorAssignmentsPath: string,
): Promise<ConnectorAssignmentsConfig> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(connectorAssignmentsPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { agents: {} };
    }
    throw error;
  }

  return parseConnectorAssignments(parsed, connectorAssignmentsPath);
}

async function saveConnectorAssignments(
  connectorAssignmentsPath: string,
  config: ConnectorAssignmentsConfig,
): Promise<void> {
  await writeSecureFile(
    connectorAssignmentsPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function parseConnectorPortFromBaseUrl(baseUrl: string): number {
  const parsed = new URL(baseUrl);
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

function allocateConnectorPort(
  assignments: ConnectorAssignmentsConfig,
  agentName: string,
): number {
  const existing = assignments.agents[agentName];
  if (existing) {
    return parseConnectorPortFromBaseUrl(existing.connectorBaseUrl);
  }

  const usedPorts = new Set<number>();
  for (const entry of Object.values(assignments.agents)) {
    usedPorts.add(parseConnectorPortFromBaseUrl(entry.connectorBaseUrl));
  }

  let nextPort = DEFAULT_CONNECTOR_PORT;
  while (usedPorts.has(nextPort)) {
    nextPort += 1;
  }

  return nextPort;
}

function buildConnectorBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function buildRelayConnectorBaseUrls(port: number): string[] {
  return [
    buildConnectorBaseUrl(CONNECTOR_HOST_DOCKER, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_DOCKER_GATEWAY, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_LINUX_BRIDGE, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_LOOPBACK, port),
  ];
}

function parseOpenclawRuntimeMode(value: unknown): OpenclawRuntimeMode {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "auto";
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "service" ||
    normalized === "detached"
  ) {
    return normalized;
  }

  throw createCliError(
    "CLI_OPENCLAW_SETUP_RUNTIME_MODE_INVALID",
    "runtimeMode must be one of: auto, service, detached",
  );
}

function parseWaitTimeoutSeconds(value: unknown): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createCliError(
      "CLI_OPENCLAW_SETUP_TIMEOUT_INVALID",
      "waitTimeoutSeconds must be a positive integer",
    );
  }

  return parsed;
}

function resolveConnectorStatusUrl(connectorBaseUrl: string): string {
  const normalizedBase = connectorBaseUrl.endsWith("/")
    ? connectorBaseUrl
    : `${connectorBaseUrl}/`;
  return new URL(
    DEFAULT_CONNECTOR_STATUS_PATH.slice(1),
    normalizedBase,
  ).toString();
}

type ConnectorHealthStatus = {
  connected: boolean;
  inboundInbox?: {
    lastReplayAt?: string;
    lastReplayError?: string;
    nextAttemptAt?: string;
    oldestPendingAt?: string;
    pendingBytes?: number;
    pendingCount?: number;
    replayerActive?: boolean;
  };
  openclawHook?: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url?: string;
  };
  reachable: boolean;
  statusUrl: string;
  reason?: string;
};

function parseConnectorStatusPayload(payload: unknown): {
  inboundInbox?: {
    lastReplayAt?: string;
    lastReplayError?: string;
    nextAttemptAt?: string;
    oldestPendingAt?: string;
    pendingBytes?: number;
    pendingCount?: number;
    replayerActive?: boolean;
  };
  openclawHook?: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url?: string;
  };
  websocketConnected: boolean;
} {
  if (!isRecord(payload) || typeof payload.websocketConnected !== "boolean") {
    throw createCliError(
      "CLI_OPENCLAW_SETUP_CONNECTOR_STATUS_INVALID",
      "Connector status response is invalid",
    );
  }

  return {
    websocketConnected: payload.websocketConnected,
    inboundInbox: isRecord(payload.inboundInbox)
      ? {
          pendingCount:
            typeof payload.inboundInbox.pendingCount === "number"
              ? payload.inboundInbox.pendingCount
              : undefined,
          pendingBytes:
            typeof payload.inboundInbox.pendingBytes === "number"
              ? payload.inboundInbox.pendingBytes
              : undefined,
          oldestPendingAt:
            typeof payload.inboundInbox.oldestPendingAt === "string"
              ? payload.inboundInbox.oldestPendingAt
              : undefined,
          nextAttemptAt:
            typeof payload.inboundInbox.nextAttemptAt === "string"
              ? payload.inboundInbox.nextAttemptAt
              : undefined,
          lastReplayAt:
            typeof payload.inboundInbox.lastReplayAt === "string"
              ? payload.inboundInbox.lastReplayAt
              : undefined,
          lastReplayError:
            typeof payload.inboundInbox.lastReplayError === "string"
              ? payload.inboundInbox.lastReplayError
              : undefined,
          replayerActive:
            typeof payload.inboundInbox.replayerActive === "boolean"
              ? payload.inboundInbox.replayerActive
              : undefined,
        }
      : undefined,
    openclawHook: isRecord(payload.openclawHook)
      ? {
          url:
            typeof payload.openclawHook.url === "string"
              ? payload.openclawHook.url
              : undefined,
          lastAttemptAt:
            typeof payload.openclawHook.lastAttemptAt === "string"
              ? payload.openclawHook.lastAttemptAt
              : undefined,
          lastAttemptStatus:
            payload.openclawHook.lastAttemptStatus === "ok" ||
            payload.openclawHook.lastAttemptStatus === "failed"
              ? payload.openclawHook.lastAttemptStatus
              : undefined,
        }
      : undefined,
  };
}

async function fetchConnectorHealthStatus(input: {
  connectorBaseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<ConnectorHealthStatus> {
  const statusUrl = resolveConnectorStatusUrl(input.connectorBaseUrl);
  try {
    const response = await input.fetchImpl(statusUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
    if (!response.ok) {
      return {
        connected: false,
        reachable: false,
        statusUrl,
        reason: `HTTP ${response.status}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        connected: false,
        reachable: false,
        statusUrl,
        reason: "invalid JSON payload",
      };
    }

    const parsed = parseConnectorStatusPayload(payload);
    return {
      connected: parsed.websocketConnected,
      inboundInbox: parsed.inboundInbox,
      openclawHook: parsed.openclawHook,
      reachable: true,
      statusUrl,
      reason: parsed.websocketConnected
        ? undefined
        : "connector websocket is disconnected",
    };
  } catch {
    return {
      connected: false,
      reachable: false,
      statusUrl,
      reason: "connector status endpoint is unreachable",
    };
  }
}

async function waitForConnectorConnected(input: {
  connectorBaseUrl: string;
  fetchImpl: typeof fetch;
  waitTimeoutSeconds: number;
}): Promise<ConnectorHealthStatus> {
  const deadline = Date.now() + input.waitTimeoutSeconds * 1000;
  let latest = await fetchConnectorHealthStatus({
    connectorBaseUrl: input.connectorBaseUrl,
    fetchImpl: input.fetchImpl,
  });

  while (!latest.connected && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    latest = await fetchConnectorHealthStatus({
      connectorBaseUrl: input.connectorBaseUrl,
      fetchImpl: input.fetchImpl,
    });
  }

  if (!latest.connected) {
    throw createCliError(
      "CLI_OPENCLAW_SETUP_CONNECTOR_NOT_READY",
      `Connector runtime is not websocket-connected after ${input.waitTimeoutSeconds} seconds`,
      {
        connectorBaseUrl: input.connectorBaseUrl,
        connectorStatusUrl: latest.statusUrl,
        reason: latest.reason,
      },
    );
  }

  return latest;
}

function sleepMilliseconds(durationMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function monitorConnectorStabilityWindow(input: {
  connectorBaseUrl: string;
  fetchImpl: typeof fetch;
  durationSeconds: number;
  pollIntervalMs: number;
}): Promise<ConnectorHealthStatus> {
  if (input.durationSeconds <= 0) {
    return fetchConnectorHealthStatus({
      connectorBaseUrl: input.connectorBaseUrl,
      fetchImpl: input.fetchImpl,
    });
  }

  const deadline = Date.now() + input.durationSeconds * 1000;
  let latest = await fetchConnectorHealthStatus({
    connectorBaseUrl: input.connectorBaseUrl,
    fetchImpl: input.fetchImpl,
  });
  if (!latest.connected) {
    return latest;
  }

  while (Date.now() < deadline) {
    await sleepMilliseconds(input.pollIntervalMs);
    latest = await fetchConnectorHealthStatus({
      connectorBaseUrl: input.connectorBaseUrl,
      fetchImpl: input.fetchImpl,
    });
    if (!latest.connected) {
      return latest;
    }
  }

  return latest;
}

function resolveConnectorRunDir(homeDir: string): string {
  return join(getConfigDir({ homeDir }), CONNECTOR_RUN_DIR_NAME);
}

function resolveConnectorPidPath(homeDir: string, agentName: string): string {
  return join(resolveConnectorRunDir(homeDir), `connector-${agentName}.pid`);
}

function resolveDetachedConnectorLogPath(
  homeDir: string,
  agentName: string,
  stream: "stdout" | "stderr",
): string {
  const suffix =
    stream === "stdout"
      ? CONNECTOR_DETACHED_STDOUT_FILE_SUFFIX
      : CONNECTOR_DETACHED_STDERR_FILE_SUFFIX;
  return join(
    resolveConnectorRunDir(homeDir),
    `connector-${agentName}.${suffix}`,
  );
}

async function readConnectorPidFile(
  pidPath: string,
): Promise<number | undefined> {
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    if (raw.length === 0) {
      return undefined;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }

    return parsed;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDetachedConnectorIfRunning(input: {
  homeDir: string;
  agentName: string;
}): Promise<void> {
  const pidPath = resolveConnectorPidPath(input.homeDir, input.agentName);
  const pid = await readConnectorPidFile(pidPath);
  if (pid === undefined || !isPidRunning(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore stale pid races; setup health checks will verify readiness.
  }
}

function resolveCliEntryPathForDetachedStart(): string {
  const argvEntry = typeof process.argv[1] === "string" ? process.argv[1] : "";
  if (argvEntry.length > 0 && existsSync(argvEntry)) {
    return argvEntry;
  }

  const modulePath = fileURLToPath(import.meta.url);
  return join(dirname(modulePath), "..", "bin.js");
}

async function startDetachedConnectorRuntime(input: {
  agentName: string;
  homeDir: string;
  openclawBaseUrl: string;
}): Promise<void> {
  await stopDetachedConnectorIfRunning({
    homeDir: input.homeDir,
    agentName: input.agentName,
  });
  const runDir = resolveConnectorRunDir(input.homeDir);
  await mkdir(runDir, { recursive: true });

  const cliEntryPath = resolveCliEntryPathForDetachedStart();
  const args = [
    cliEntryPath,
    "connector",
    "start",
    input.agentName,
    "--openclaw-base-url",
    input.openclawBaseUrl,
  ];
  const stdoutLogPath = resolveDetachedConnectorLogPath(
    input.homeDir,
    input.agentName,
    "stdout",
  );
  const stderrLogPath = resolveDetachedConnectorLogPath(
    input.homeDir,
    input.agentName,
    "stderr",
  );
  const stdoutFd = openSync(stdoutLogPath, "a");
  const stderrFd = openSync(stderrLogPath, "a");

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
    });
    child.unref();
    await writeSecureFile(
      resolveConnectorPidPath(input.homeDir, input.agentName),
      `${child.pid}\n`,
    );
    logger.info("cli.openclaw.setup.detached_runtime_started", {
      agentName: input.agentName,
      pid: child.pid,
      stdoutLogPath,
      stderrLogPath,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}

async function startSetupConnectorRuntime(input: {
  agentName: string;
  homeDir: string;
  openclawBaseUrl: string;
  connectorBaseUrl: string;
  mode: OpenclawRuntimeMode;
  waitTimeoutSeconds: number;
  fetchImpl: typeof fetch;
}): Promise<OpenclawRuntimeResult> {
  if (input.mode !== "service") {
    const existingStatus = await fetchConnectorHealthStatus({
      connectorBaseUrl: input.connectorBaseUrl,
      fetchImpl: input.fetchImpl,
    });
    if (existingStatus.connected) {
      return {
        runtimeMode: "existing",
        runtimeStatus: "running",
        websocketStatus: "connected",
        connectorStatusUrl: existingStatus.statusUrl,
      };
    }
  }

  let runtimeMode: "service" | "detached" = "service";
  if (input.mode === "detached") {
    runtimeMode = "detached";
  } else {
    try {
      await installConnectorServiceForAgent(input.agentName, {
        platform: "auto",
        openclawBaseUrl: input.openclawBaseUrl,
      });
      runtimeMode = "service";
    } catch (error) {
      if (input.mode === "service") {
        throw error;
      }
      runtimeMode = "detached";
      logger.warn("cli.openclaw.setup.service_fallback_detached", {
        agentName: input.agentName,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  if (runtimeMode === "detached") {
    await startDetachedConnectorRuntime({
      agentName: input.agentName,
      homeDir: input.homeDir,
      openclawBaseUrl: input.openclawBaseUrl,
    });
  }

  const connectedStatus = await waitForConnectorConnected({
    connectorBaseUrl: input.connectorBaseUrl,
    fetchImpl: input.fetchImpl,
    waitTimeoutSeconds: input.waitTimeoutSeconds,
  });

  return {
    runtimeMode,
    runtimeStatus: "running",
    websocketStatus: "connected",
    connectorStatusUrl: connectedStatus.statusUrl,
  };
}

function parseRelayRuntimeConfig(
  value: unknown,
  relayRuntimeConfigPath: string,
): OpenclawRelayRuntimeConfig {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_RELAY_RUNTIME_CONFIG",
      "Relay runtime config must be an object",
      { relayRuntimeConfigPath },
    );
  }

  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim().length > 0
      ? value.updatedAt.trim()
      : undefined;
  const openclawHookToken =
    typeof value.openclawHookToken === "string" &&
    value.openclawHookToken.trim().length > 0
      ? value.openclawHookToken.trim()
      : undefined;
  const relayTransformPeersPath =
    typeof value.relayTransformPeersPath === "string" &&
    value.relayTransformPeersPath.trim().length > 0
      ? value.relayTransformPeersPath.trim()
      : undefined;

  return {
    openclawBaseUrl: parseOpenclawBaseUrl(value.openclawBaseUrl),
    openclawHookToken,
    relayTransformPeersPath,
    updatedAt,
  };
}

async function loadRelayRuntimeConfig(
  relayRuntimeConfigPath: string,
): Promise<OpenclawRelayRuntimeConfig | undefined> {
  let parsed: unknown;
  try {
    parsed = await readJsonFile(relayRuntimeConfigPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }

  return parseRelayRuntimeConfig(parsed, relayRuntimeConfigPath);
}

async function saveRelayRuntimeConfig(
  relayRuntimeConfigPath: string,
  openclawBaseUrl: string,
  openclawHookToken?: string,
  relayTransformPeersPath?: string,
): Promise<void> {
  const config: OpenclawRelayRuntimeConfig = {
    openclawBaseUrl,
    ...(openclawHookToken ? { openclawHookToken } : {}),
    ...(relayTransformPeersPath ? { relayTransformPeersPath } : {}),
    updatedAt: nowIso(),
  };

  await writeSecureFile(
    relayRuntimeConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

async function resolveOpenclawBaseUrl(input: {
  optionValue?: string;
  relayRuntimeConfigPath: string;
}): Promise<string> {
  if (
    typeof input.optionValue === "string" &&
    input.optionValue.trim().length > 0
  ) {
    return parseOpenclawBaseUrl(input.optionValue);
  }

  const envOpenclawBaseUrl = process.env.OPENCLAW_BASE_URL;
  if (
    typeof envOpenclawBaseUrl === "string" &&
    envOpenclawBaseUrl.trim().length > 0
  ) {
    return parseOpenclawBaseUrl(envOpenclawBaseUrl);
  }

  const existingConfig = await loadRelayRuntimeConfig(
    input.relayRuntimeConfigPath,
  );
  if (existingConfig !== undefined) {
    return existingConfig.openclawBaseUrl;
  }

  return DEFAULT_OPENCLAW_BASE_URL;
}

function normalizeStringArrayWithValues(
  value: unknown,
  requiredValues: readonly string[],
): string[] {
  const normalized = new Set<string>();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }

      const trimmed = item.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }
  }

  for (const requiredValue of requiredValues) {
    const trimmed = requiredValue.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return Array.from(normalized);
}

function resolveHookDefaultSessionKey(
  config: Record<string, unknown>,
  hooks: Record<string, unknown>,
): string {
  const session = isRecord(config.session) ? config.session : {};
  const scope =
    typeof session.scope === "string" ? session.scope.trim().toLowerCase() : "";
  const configuredMainSessionKey =
    resolveConfiguredOpenclawMainSessionKey(session);

  if (
    typeof hooks.defaultSessionKey === "string" &&
    hooks.defaultSessionKey.trim().length > 0
  ) {
    return normalizeLegacyHookDefaultSessionKey(
      hooks.defaultSessionKey,
      configuredMainSessionKey,
    );
  }

  if (scope === "global") {
    return "global";
  }

  return configuredMainSessionKey;
}

function resolveConfiguredOpenclawMainSessionKey(
  session: Record<string, unknown>,
): string {
  if (
    typeof session.mainKey === "string" &&
    session.mainKey.trim().length > 0
  ) {
    return session.mainKey.trim();
  }

  return DEFAULT_OPENCLAW_MAIN_SESSION_KEY;
}

function normalizeLegacyHookDefaultSessionKey(
  value: string,
  fallbackSessionKey: string,
): string {
  const trimmed = value.trim();
  const legacyMatch = /^agent:[^:]+:(.+)$/i.exec(trimmed);
  if (!legacyMatch) {
    return trimmed;
  }
  const routedSessionKey = legacyMatch[1]?.trim();
  if (typeof routedSessionKey === "string" && routedSessionKey.length > 0) {
    return routedSessionKey;
  }

  return fallbackSessionKey;
}

function isCanonicalAgentSessionKey(value: string): boolean {
  return /^agent:[^:]+:.+/i.test(value.trim());
}

function generateOpenclawHookToken(): string {
  return randomBytes(OPENCLAW_HOOK_TOKEN_BYTES).toString("hex");
}

function generateOpenclawGatewayToken(): string {
  return randomBytes(OPENCLAW_HOOK_TOKEN_BYTES).toString("hex");
}

function parseGatewayAuthMode(
  value: unknown,
): "token" | "password" | "trusted-proxy" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "token" ||
    normalized === "password" ||
    normalized === "trusted-proxy"
  ) {
    return normalized;
  }
  return undefined;
}

function resolveEnvOpenclawGatewayToken(): string | undefined {
  if (
    typeof process.env.OPENCLAW_GATEWAY_TOKEN === "string" &&
    process.env.OPENCLAW_GATEWAY_TOKEN.trim().length > 0
  ) {
    return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
  }
  return undefined;
}

function resolveGatewayAuthToken(existingToken?: string): string {
  return (
    resolveEnvOpenclawGatewayToken() ??
    existingToken ??
    generateOpenclawGatewayToken()
  );
}

function upsertRelayHookMapping(
  mappingsValue: unknown,
): Record<string, unknown>[] {
  const mappings = Array.isArray(mappingsValue)
    ? mappingsValue.filter(isRecord).map((mapping) => ({ ...mapping }))
    : [];

  const existingIndex = mappings.findIndex((mapping) => {
    if (mapping.id === HOOK_MAPPING_ID) {
      return true;
    }

    if (!isRecord(mapping.match)) {
      return false;
    }

    return mapping.match.path === HOOK_PATH_SEND_TO_PEER;
  });

  const baseMapping =
    existingIndex >= 0 && isRecord(mappings[existingIndex])
      ? mappings[existingIndex]
      : {};

  const nextMatch = isRecord(baseMapping.match) ? { ...baseMapping.match } : {};
  nextMatch.path = HOOK_PATH_SEND_TO_PEER;

  const nextTransform = isRecord(baseMapping.transform)
    ? { ...baseMapping.transform }
    : {};
  nextTransform.module = RELAY_MODULE_FILE_NAME;

  const relayMapping: Record<string, unknown> = {
    ...baseMapping,
    id: HOOK_MAPPING_ID,
    match: nextMatch,
    action: "agent",
    wakeMode: "now",
    transform: nextTransform,
  };

  if (existingIndex >= 0) {
    mappings[existingIndex] = relayMapping;
    return mappings;
  }

  mappings.push(relayMapping);
  return mappings;
}

async function patchOpenclawConfig(
  openclawConfigPath: string,
  hookToken?: string,
): Promise<{ hookToken: string; configChanged: boolean }> {
  let config: unknown;
  try {
    config = await readJsonFile(openclawConfigPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_OPENCLAW_CONFIG_NOT_FOUND",
        "OpenClaw config file was not found",
        { openclawConfigPath },
      );
    }

    throw error;
  }

  if (!isRecord(config)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_CONFIG",
      "OpenClaw config root must be an object",
      { openclawConfigPath },
    );
  }

  const hooks = isRecord(config.hooks) ? { ...config.hooks } : {};
  const existingHookToken =
    typeof hooks.token === "string" && hooks.token.trim().length > 0
      ? hooks.token.trim()
      : undefined;
  const preferredHookToken =
    typeof hookToken === "string" && hookToken.trim().length > 0
      ? hookToken.trim()
      : undefined;
  const resolvedHookToken =
    existingHookToken ?? preferredHookToken ?? generateOpenclawHookToken();
  const defaultSessionKey = resolveHookDefaultSessionKey(config, hooks);

  hooks.enabled = true;
  hooks.token = resolvedHookToken;
  hooks.defaultSessionKey = defaultSessionKey;
  hooks.allowRequestSessionKey = false;
  hooks.allowedSessionKeyPrefixes = normalizeStringArrayWithValues(
    hooks.allowedSessionKeyPrefixes,
    ["hook:", defaultSessionKey],
  );
  hooks.mappings = upsertRelayHookMapping(hooks.mappings);

  const gateway = isRecord(config.gateway) ? { ...config.gateway } : {};
  const gatewayAuth = isRecord(gateway.auth) ? { ...gateway.auth } : {};
  const configuredGatewayAuthMode = parseGatewayAuthMode(gatewayAuth.mode);
  if (configuredGatewayAuthMode === undefined) {
    gatewayAuth.mode = "token";
  }

  const effectiveGatewayAuthMode =
    parseGatewayAuthMode(gatewayAuth.mode) ?? "token";
  if (effectiveGatewayAuthMode === "token") {
    const existingGatewayAuthToken =
      typeof gatewayAuth.token === "string" &&
      gatewayAuth.token.trim().length > 0
        ? gatewayAuth.token.trim()
        : undefined;
    gatewayAuth.token = resolveGatewayAuthToken(existingGatewayAuthToken);
  }
  gateway.auth = gatewayAuth;

  const nextConfig = {
    ...config,
    hooks,
    gateway,
  };
  const configChanged = JSON.stringify(config) !== JSON.stringify(nextConfig);
  if (configChanged) {
    await writeFile(
      openclawConfigPath,
      `${JSON.stringify(nextConfig, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    hookToken: resolvedHookToken,
    configChanged,
  };
}

function toDoctorCheck(
  input: OpenclawDoctorCheckResult,
): OpenclawDoctorCheckResult {
  return input;
}

function toDoctorResult(
  checks: OpenclawDoctorCheckResult[],
): OpenclawDoctorResult {
  return {
    status: checks.every((check) => check.status === "pass")
      ? "healthy"
      : "unhealthy",
    checkedAt: nowIso(),
    checks,
  };
}

function isRelayHookMapping(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (!isRecord(value.match) || value.match.path !== HOOK_PATH_SEND_TO_PEER) {
    return false;
  }

  if (typeof value.id === "string" && value.id !== HOOK_MAPPING_ID) {
    return false;
  }

  return true;
}

function hasRelayTransformModule(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.transform)) {
    return false;
  }

  return value.transform.module === RELAY_MODULE_FILE_NAME;
}

function parseDoctorPeerAlias(peerAlias?: string): string | undefined {
  if (peerAlias === undefined) {
    return undefined;
  }

  return parsePeerAlias(peerAlias);
}

async function resolveHookToken(input: {
  optionValue?: string;
  relayRuntimeConfigPath: string;
}): Promise<string | undefined> {
  const trimmedOption = input.optionValue?.trim();
  if (trimmedOption !== undefined && trimmedOption.length > 0) {
    return trimmedOption;
  }

  const envValue = process.env.OPENCLAW_HOOK_TOKEN?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }

  const existingConfig = await loadRelayRuntimeConfig(
    input.relayRuntimeConfigPath,
  );
  if (existingConfig?.openclawHookToken) {
    return existingConfig.openclawHookToken;
  }

  return undefined;
}

function resolveProbeMessage(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity relay probe";
}

function resolveProbeSessionId(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity-relay-test";
}

function formatDoctorCheckLine(check: OpenclawDoctorCheckResult): string {
  const icon = check.status === "pass" ? "✅" : "❌";
  return `${icon} ${check.label}: ${check.message}`;
}

function printDoctorResult(result: OpenclawDoctorResult): void {
  writeStdoutLine(`OpenClaw doctor status: ${result.status}`);
  for (const check of result.checks) {
    writeStdoutLine(formatDoctorCheckLine(check));
    if (check.status === "fail" && check.remediationHint) {
      writeStdoutLine(`Fix: ${check.remediationHint}`);
    }
  }
}

function printRelayTestResult(result: OpenclawRelayTestResult): void {
  writeStdoutLine(`Relay test status: ${result.status}`);
  writeStdoutLine(`Peer alias: ${result.peerAlias}`);
  writeStdoutLine(`Endpoint: ${result.endpoint}`);
  if (typeof result.httpStatus === "number") {
    writeStdoutLine(`HTTP status: ${result.httpStatus}`);
  }
  writeStdoutLine(`Message: ${result.message}`);
  if (result.remediationHint) {
    writeStdoutLine(`Fix: ${result.remediationHint}`);
  }
}

function toSendToPeerEndpoint(openclawBaseUrl: string): string {
  const normalizedBase = openclawBaseUrl.endsWith("/")
    ? openclawBaseUrl
    : `${openclawBaseUrl}/`;
  return new URL(OPENCLAW_SEND_TO_PEER_HOOK_PATH, normalizedBase).toString();
}

export async function runOpenclawDoctor(
  options: OpenclawDoctorOptions = {},
): Promise<OpenclawDoctorResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const peerAlias = parseDoctorPeerAlias(options.peerAlias);
  const checks: OpenclawDoctorCheckResult[] = [];

  if (options.includeConfigCheck !== false) {
    const resolveConfigImpl = options.resolveConfigImpl ?? resolveConfig;
    try {
      const resolvedConfig = await resolveConfigImpl();
      const envProxyUrl =
        typeof process.env.CLAWDENTITY_PROXY_URL === "string"
          ? process.env.CLAWDENTITY_PROXY_URL.trim()
          : "";
      if (
        typeof resolvedConfig.registryUrl !== "string" ||
        resolvedConfig.registryUrl.trim().length === 0
      ) {
        checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "fail",
            message: "registryUrl is missing",
            remediationHint:
              "Run: clawdentity config set registryUrl <REGISTRY_URL>",
          }),
        );
      } else if (
        typeof resolvedConfig.apiKey !== "string" ||
        resolvedConfig.apiKey.trim().length === 0
      ) {
        checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "fail",
            message: "apiKey is missing",
            remediationHint: "Run: clawdentity config set apiKey <API_KEY>",
          }),
        );
      } else if (envProxyUrl.length > 0) {
        let hasValidEnvProxyUrl = true;
        try {
          parseProxyUrl(envProxyUrl);
        } catch {
          hasValidEnvProxyUrl = false;
          checks.push(
            toDoctorCheck({
              id: "config.registry",
              label: "CLI config",
              status: "fail",
              message: "CLAWDENTITY_PROXY_URL is invalid",
              remediationHint:
                "Set CLAWDENTITY_PROXY_URL to a valid http(s) URL or unset it",
            }),
          );
        }

        if (hasValidEnvProxyUrl) {
          checks.push(
            toDoctorCheck({
              id: "config.registry",
              label: "CLI config",
              status: "pass",
              message:
                "registryUrl and apiKey are configured (proxy URL override is active via CLAWDENTITY_PROXY_URL)",
            }),
          );
        }
      } else if (
        typeof resolvedConfig.proxyUrl !== "string" ||
        resolvedConfig.proxyUrl.trim().length === 0
      ) {
        checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "fail",
            message: "proxyUrl is missing",
            remediationHint:
              "Run: clawdentity invite redeem <clw_inv_...> or clawdentity config init",
          }),
        );
      } else {
        let hasValidConfigProxyUrl = true;
        try {
          parseProxyUrl(resolvedConfig.proxyUrl);
        } catch {
          hasValidConfigProxyUrl = false;
          checks.push(
            toDoctorCheck({
              id: "config.registry",
              label: "CLI config",
              status: "fail",
              message: "proxyUrl is invalid",
              remediationHint:
                "Run: clawdentity invite redeem <clw_inv_...> or clawdentity config init",
            }),
          );
        }

        if (hasValidConfigProxyUrl) {
          checks.push(
            toDoctorCheck({
              id: "config.registry",
              label: "CLI config",
              status: "pass",
              message: "registryUrl, apiKey, and proxyUrl are configured",
            }),
          );
        }
      }
    } catch {
      checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "unable to resolve CLI config",
          remediationHint:
            "Run: clawdentity config init (or fix your CLI state config file)",
        }),
      );
    }
  }

  const selectedAgentPath = resolveOpenclawAgentNamePath(homeDir);
  let selectedAgentName: string | undefined;
  try {
    const selectedAgentRaw = await readFile(selectedAgentPath, "utf8");
    selectedAgentName = assertValidAgentName(selectedAgentRaw.trim());
    checks.push(
      toDoctorCheck({
        id: "state.selectedAgent",
        label: "Selected agent marker",
        status: "pass",
        message: `selected agent is ${selectedAgentName}`,
      }),
    );
  } catch (error) {
    const missing = getErrorCode(error) === "ENOENT";
    checks.push(
      toDoctorCheck({
        id: "state.selectedAgent",
        label: "Selected agent marker",
        status: "fail",
        message: missing
          ? `missing ${selectedAgentPath}`
          : "selected agent marker is invalid",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
  }

  if (selectedAgentName === undefined) {
    checks.push(
      toDoctorCheck({
        id: "state.credentials",
        label: "Local agent credentials",
        status: "fail",
        message: "cannot validate credentials without selected agent marker",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
  } else {
    try {
      await ensureLocalAgentCredentials(homeDir, selectedAgentName);
      checks.push(
        toDoctorCheck({
          id: "state.credentials",
          label: "Local agent credentials",
          status: "pass",
          message: "ait.jwt and secret.key are present",
        }),
      );
    } catch (error) {
      const details = error instanceof AppError ? error.details : undefined;
      const filePath =
        details && typeof details.filePath === "string"
          ? details.filePath
          : undefined;
      checks.push(
        toDoctorCheck({
          id: "state.credentials",
          label: "Local agent credentials",
          status: "fail",
          message:
            filePath === undefined
              ? "agent credentials are missing or invalid"
              : `credential file missing or empty: ${filePath}`,
          remediationHint:
            "Run: clawdentity agent create <agentName> --framework openclaw",
          details:
            filePath === undefined
              ? undefined
              : { filePath, selectedAgentName },
        }),
      );
    }
  }

  const peersPath = resolvePeersPath(homeDir);
  let peersConfig: PeersConfig | undefined;
  try {
    peersConfig = await loadPeersConfig(peersPath);
    const peerAliases = Object.keys(peersConfig.peers);
    if (peerAlias !== undefined) {
      if (peersConfig.peers[peerAlias] === undefined) {
        checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "fail",
            message: `peer alias is missing: ${peerAlias}`,
            remediationHint: OPENCLAW_PAIRING_COMMAND_HINT,
            details: { peersPath, peerAlias },
          }),
        );
      } else {
        checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "pass",
            message: `peer alias exists: ${peerAlias}`,
            details: { peersPath, peerAlias },
          }),
        );
      }
    } else if (peerAliases.length === 0) {
      checks.push(
        toDoctorCheck({
          id: "state.peers",
          label: "Peers map",
          status: "pass",
          message: "no peers are configured yet (optional until pairing)",
          details: { peersPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.peers",
          label: "Peers map",
          status: "pass",
          message: `configured peers: ${peerAliases.length}`,
          details: { peersPath },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.peers",
        label: "Peers map",
        status: "fail",
        message: `invalid peers config at ${peersPath}`,
        remediationHint: `Fix JSON in ${peersPath} or rerun openclaw setup`,
        details: { peersPath },
      }),
    );
  }

  const transformTargetPath = resolveTransformTargetPath(openclawDir);
  const relayTransformRuntimePath = resolveTransformRuntimePath(openclawDir);
  const relayTransformPeersPath = resolveTransformPeersPath(openclawDir);
  try {
    const transformContents = await readFile(transformTargetPath, "utf8");
    const runtimeContents = await readFile(relayTransformRuntimePath, "utf8");
    const peersSnapshotContents = await readFile(
      relayTransformPeersPath,
      "utf8",
    );

    if (
      transformContents.trim().length === 0 ||
      runtimeContents.trim().length === 0 ||
      peersSnapshotContents.trim().length === 0
    ) {
      checks.push(
        toDoctorCheck({
          id: "state.transform",
          label: "Relay transform",
          status: "fail",
          message: "relay transform artifacts are missing or empty",
          remediationHint: "Run: clawdentity skill install",
          details: {
            transformTargetPath,
            relayTransformRuntimePath,
            relayTransformPeersPath,
          },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.transform",
          label: "Relay transform",
          status: "pass",
          message: "relay transform artifacts are present",
          details: {
            transformTargetPath,
            relayTransformRuntimePath,
            relayTransformPeersPath,
          },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.transform",
        label: "Relay transform",
        status: "fail",
        message: "missing relay transform artifacts",
        remediationHint: "Run: clawdentity skill install",
        details: {
          transformTargetPath,
          relayTransformRuntimePath,
          relayTransformPeersPath,
        },
      }),
    );
  }

  const openclawConfigPath = resolveOpenclawConfigPath(openclawDir, homeDir);
  try {
    const openclawConfig = await readJsonFile(openclawConfigPath);
    if (!isRecord(openclawConfig)) {
      throw new Error("root");
    }
    const hooks = isRecord(openclawConfig.hooks) ? openclawConfig.hooks : {};
    const hooksEnabled = hooks.enabled === true;
    const hookToken =
      typeof hooks.token === "string" && hooks.token.trim().length > 0
        ? hooks.token.trim()
        : undefined;
    const defaultSessionKey =
      typeof hooks.defaultSessionKey === "string" &&
      hooks.defaultSessionKey.trim().length > 0
        ? hooks.defaultSessionKey.trim()
        : undefined;
    const allowRequestSessionKey = hooks.allowRequestSessionKey === false;
    const allowedSessionKeyPrefixes = normalizeStringArrayWithValues(
      hooks.allowedSessionKeyPrefixes,
      [],
    );
    const missingRequiredSessionPrefixes =
      defaultSessionKey === undefined
        ? ["hook:"]
        : ["hook:", defaultSessionKey].filter(
            (prefix) => !allowedSessionKeyPrefixes.includes(prefix),
          );
    const mappings = Array.isArray(hooks.mappings)
      ? hooks.mappings.filter(isRecord)
      : [];
    const relayMapping = mappings.find((mapping) =>
      isRelayHookMapping(mapping),
    );
    if (relayMapping === undefined || !hasRelayTransformModule(relayMapping)) {
      checks.push(
        toDoctorCheck({
          id: "state.hookMapping",
          label: "OpenClaw hook mapping",
          status: "fail",
          message: `missing send-to-peer mapping in ${openclawConfigPath}`,
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
          details: { openclawConfigPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.hookMapping",
          label: "OpenClaw hook mapping",
          status: "pass",
          message: "send-to-peer mapping is configured",
          details: { openclawConfigPath },
        }),
      );
    }

    if (!hooksEnabled) {
      checks.push(
        toDoctorCheck({
          id: "state.hookToken",
          label: "OpenClaw hook auth",
          status: "fail",
          message: `hooks.enabled is not true in ${openclawConfigPath}`,
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
          details: { openclawConfigPath },
        }),
      );
    } else if (hookToken === undefined) {
      checks.push(
        toDoctorCheck({
          id: "state.hookToken",
          label: "OpenClaw hook auth",
          status: "fail",
          message: `hooks.token is missing in ${openclawConfigPath}`,
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
          details: { openclawConfigPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.hookToken",
          label: "OpenClaw hook auth",
          status: "pass",
          message: "hooks token is configured",
          details: { openclawConfigPath },
        }),
      );
    }

    const sessionRoutingIssues: string[] = [];
    if (defaultSessionKey === undefined) {
      sessionRoutingIssues.push("hooks.defaultSessionKey is missing");
    }
    if (!allowRequestSessionKey) {
      sessionRoutingIssues.push("hooks.allowRequestSessionKey is not false");
    }
    if (missingRequiredSessionPrefixes.length > 0) {
      sessionRoutingIssues.push(
        `hooks.allowedSessionKeyPrefixes is missing: ${missingRequiredSessionPrefixes.join(", ")}`,
      );
    }
    if (
      defaultSessionKey !== undefined &&
      isCanonicalAgentSessionKey(defaultSessionKey)
    ) {
      sessionRoutingIssues.push(
        "hooks.defaultSessionKey uses canonical agent format (agent:<id>:...); use OpenClaw request session keys like main, global, or subagent:*",
      );
    }

    if (sessionRoutingIssues.length > 0) {
      checks.push(
        toDoctorCheck({
          id: "state.hookSessionRouting",
          label: "OpenClaw hook session routing",
          status: "fail",
          message: sessionRoutingIssues.join("; "),
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
          details: { openclawConfigPath },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.hookSessionRouting",
          label: "OpenClaw hook session routing",
          status: "pass",
          message:
            "hooks default session and allowed session prefixes are configured",
          details: { openclawConfigPath },
        }),
      );
    }

    const gateway = isRecord(openclawConfig.gateway)
      ? openclawConfig.gateway
      : {};
    const gatewayAuth = isRecord(gateway.auth) ? gateway.auth : {};
    const gatewayAuthMode = parseGatewayAuthMode(gatewayAuth.mode);
    const gatewayAuthToken =
      typeof gatewayAuth.token === "string" &&
      gatewayAuth.token.trim().length > 0
        ? gatewayAuth.token.trim()
        : undefined;
    const gatewayAuthPassword =
      typeof gatewayAuth.password === "string" &&
      gatewayAuth.password.trim().length > 0
        ? gatewayAuth.password.trim()
        : undefined;

    if (gatewayAuthMode === "token") {
      if (gatewayAuthToken === undefined) {
        checks.push(
          toDoctorCheck({
            id: "state.gatewayAuth",
            label: "OpenClaw gateway auth",
            status: "fail",
            message: `gateway.auth.token is missing in ${openclawConfigPath}`,
            remediationHint: OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT,
            details: { openclawConfigPath, gatewayAuthMode },
          }),
        );
      } else {
        checks.push(
          toDoctorCheck({
            id: "state.gatewayAuth",
            label: "OpenClaw gateway auth",
            status: "pass",
            message: "gateway auth is configured with token mode",
            details: { openclawConfigPath, gatewayAuthMode },
          }),
        );
      }
    } else if (gatewayAuthMode === "password") {
      if (gatewayAuthPassword === undefined) {
        checks.push(
          toDoctorCheck({
            id: "state.gatewayAuth",
            label: "OpenClaw gateway auth",
            status: "fail",
            message: `gateway.auth.password is missing in ${openclawConfigPath}`,
            remediationHint: OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT,
            details: { openclawConfigPath, gatewayAuthMode },
          }),
        );
      } else {
        checks.push(
          toDoctorCheck({
            id: "state.gatewayAuth",
            label: "OpenClaw gateway auth",
            status: "pass",
            message: "gateway auth is configured with password mode",
            details: { openclawConfigPath, gatewayAuthMode },
          }),
        );
      }
    } else if (gatewayAuthMode === "trusted-proxy") {
      checks.push(
        toDoctorCheck({
          id: "state.gatewayAuth",
          label: "OpenClaw gateway auth",
          status: "pass",
          message: "gateway auth is configured with trusted-proxy mode",
          details: { openclawConfigPath, gatewayAuthMode },
        }),
      );
    } else {
      checks.push(
        toDoctorCheck({
          id: "state.gatewayAuth",
          label: "OpenClaw gateway auth",
          status: "fail",
          message: `gateway.auth.mode is missing or unsupported in ${openclawConfigPath}`,
          remediationHint: OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT,
          details: { openclawConfigPath },
        }),
      );
    }
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.hookMapping",
        label: "OpenClaw hook mapping",
        status: "fail",
        message: `unable to read ${openclawConfigPath}`,
        remediationHint:
          "Ensure the OpenClaw config file exists (OPENCLAW_CONFIG_PATH/CLAWDBOT_CONFIG_PATH, or state dir) and rerun openclaw setup",
        details: { openclawConfigPath },
      }),
    );
    checks.push(
      toDoctorCheck({
        id: "state.hookToken",
        label: "OpenClaw hook auth",
        status: "fail",
        message: `unable to read ${openclawConfigPath}`,
        remediationHint:
          "Ensure the OpenClaw config file exists (OPENCLAW_CONFIG_PATH/CLAWDBOT_CONFIG_PATH, or state dir) and rerun openclaw setup",
        details: { openclawConfigPath },
      }),
    );
    checks.push(
      toDoctorCheck({
        id: "state.hookSessionRouting",
        label: "OpenClaw hook session routing",
        status: "fail",
        message: `unable to read ${openclawConfigPath}`,
        remediationHint:
          "Ensure the OpenClaw config file exists (OPENCLAW_CONFIG_PATH/CLAWDBOT_CONFIG_PATH, or state dir) and rerun openclaw setup",
        details: { openclawConfigPath },
      }),
    );
    checks.push(
      toDoctorCheck({
        id: "state.gatewayAuth",
        label: "OpenClaw gateway auth",
        status: "fail",
        message: `unable to read ${openclawConfigPath}`,
        remediationHint:
          "Ensure the OpenClaw config file exists (OPENCLAW_CONFIG_PATH/CLAWDBOT_CONFIG_PATH, or state dir) and rerun openclaw setup",
        details: { openclawConfigPath },
      }),
    );
  }

  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  try {
    const openclawBaseUrl = await resolveOpenclawBaseUrl({
      relayRuntimeConfigPath,
    });
    checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "pass",
        message: `resolved to ${openclawBaseUrl}`,
      }),
    );
  } catch {
    checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "fail",
        message: `unable to resolve OpenClaw base URL from ${relayRuntimeConfigPath}`,
        remediationHint: OPENCLAW_SETUP_WITH_BASE_URL_HINT,
      }),
    );
  }

  const gatewayPendingState =
    await readOpenclawGatewayPendingState(openclawDir);
  if (gatewayPendingState.status === "missing") {
    checks.push(
      toDoctorCheck({
        id: "state.gatewayDevicePairing",
        label: "OpenClaw gateway device pairing",
        status: "pass",
        message: "no pending gateway device approvals file was found",
        details: {
          gatewayDevicePendingPath:
            gatewayPendingState.gatewayDevicePendingPath,
        },
      }),
    );
  } else if (gatewayPendingState.status === "invalid") {
    checks.push(
      toDoctorCheck({
        id: "state.gatewayDevicePairing",
        label: "OpenClaw gateway device pairing",
        status: "fail",
        message: `invalid pending device approvals file: ${gatewayPendingState.gatewayDevicePendingPath}`,
        remediationHint: OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT,
        details: {
          gatewayDevicePendingPath:
            gatewayPendingState.gatewayDevicePendingPath,
        },
      }),
    );
  } else if (gatewayPendingState.status === "unreadable") {
    checks.push(
      toDoctorCheck({
        id: "state.gatewayDevicePairing",
        label: "OpenClaw gateway device pairing",
        status: "fail",
        message: `unable to read pending device approvals at ${gatewayPendingState.gatewayDevicePendingPath}`,
        remediationHint: OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT,
        details: {
          gatewayDevicePendingPath:
            gatewayPendingState.gatewayDevicePendingPath,
        },
      }),
    );
  } else if (gatewayPendingState.pendingRequestIds.length === 0) {
    checks.push(
      toDoctorCheck({
        id: "state.gatewayDevicePairing",
        label: "OpenClaw gateway device pairing",
        status: "pass",
        message: "no pending gateway device approvals",
        details: {
          gatewayDevicePendingPath:
            gatewayPendingState.gatewayDevicePendingPath,
        },
      }),
    );
  } else {
    checks.push(
      toDoctorCheck({
        id: "state.gatewayDevicePairing",
        label: "OpenClaw gateway device pairing",
        status: "fail",
        message: `pending gateway device approvals: ${gatewayPendingState.pendingRequestIds.length}`,
        remediationHint: OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT,
        details: {
          gatewayDevicePendingPath:
            gatewayPendingState.gatewayDevicePendingPath,
          pendingRequestIds: gatewayPendingState.pendingRequestIds,
        },
      }),
    );
  }

  if (options.includeConnectorRuntimeCheck !== false) {
    if (selectedAgentName === undefined) {
      checks.push(
        toDoctorCheck({
          id: "state.connectorRuntime",
          label: "Connector runtime",
          status: "fail",
          message:
            "cannot validate connector runtime without selected agent marker",
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
        }),
      );
      checks.push(
        toDoctorCheck({
          id: "state.connectorInboundInbox",
          label: "Connector inbound inbox",
          status: "fail",
          message:
            "cannot validate connector inbound inbox without selected agent marker",
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
        }),
      );
      checks.push(
        toDoctorCheck({
          id: "state.openclawHookHealth",
          label: "OpenClaw hook health",
          status: "fail",
          message:
            "cannot validate OpenClaw hook health without selected agent marker",
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
        }),
      );
    } else {
      const connectorAssignmentsPath = resolveConnectorAssignmentsPath(homeDir);
      try {
        const connectorAssignments = await loadConnectorAssignments(
          connectorAssignmentsPath,
        );
        const assignment = connectorAssignments.agents[selectedAgentName];
        if (assignment === undefined) {
          checks.push(
            toDoctorCheck({
              id: "state.connectorRuntime",
              label: "Connector runtime",
              status: "fail",
              message: `no connector assignment found for ${selectedAgentName}`,
              remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
              details: { connectorAssignmentsPath, selectedAgentName },
            }),
          );
          checks.push(
            toDoctorCheck({
              id: "state.connectorInboundInbox",
              label: "Connector inbound inbox",
              status: "fail",
              message: `no connector assignment found for ${selectedAgentName}`,
              remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
              details: { connectorAssignmentsPath, selectedAgentName },
            }),
          );
          checks.push(
            toDoctorCheck({
              id: "state.openclawHookHealth",
              label: "OpenClaw hook health",
              status: "fail",
              message: `no connector assignment found for ${selectedAgentName}`,
              remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
              details: { connectorAssignmentsPath, selectedAgentName },
            }),
          );
        } else {
          const fetchImpl = options.fetchImpl ?? globalThis.fetch;
          if (typeof fetchImpl !== "function") {
            checks.push(
              toDoctorCheck({
                id: "state.connectorRuntime",
                label: "Connector runtime",
                status: "fail",
                message:
                  "fetch implementation is unavailable for connector checks",
                remediationHint:
                  "Run doctor in a Node runtime with fetch support, or rerun openclaw setup",
              }),
            );
            checks.push(
              toDoctorCheck({
                id: "state.connectorInboundInbox",
                label: "Connector inbound inbox",
                status: "fail",
                message:
                  "fetch implementation is unavailable for connector inbox checks",
                remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
              }),
            );
            checks.push(
              toDoctorCheck({
                id: "state.openclawHookHealth",
                label: "OpenClaw hook health",
                status: "fail",
                message:
                  "fetch implementation is unavailable for OpenClaw hook health checks",
                remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
              }),
            );
          } else {
            const connectorStatus = await fetchConnectorHealthStatus({
              connectorBaseUrl: assignment.connectorBaseUrl,
              fetchImpl,
            });
            if (connectorStatus.connected) {
              checks.push(
                toDoctorCheck({
                  id: "state.connectorRuntime",
                  label: "Connector runtime",
                  status: "pass",
                  message: `connector websocket is connected (${assignment.connectorBaseUrl})`,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                  },
                }),
              );
              const inboxPendingCount =
                connectorStatus.inboundInbox?.pendingCount ?? 0;
              const replayError = connectorStatus.inboundInbox?.lastReplayError;
              checks.push(
                toDoctorCheck({
                  id: "state.connectorInboundInbox",
                  label: "Connector inbound inbox",
                  status: "pass",
                  message:
                    inboxPendingCount === 0
                      ? "connector inbound inbox is empty"
                      : `connector inbound inbox has ${inboxPendingCount} pending message(s)`,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                    ...connectorStatus.inboundInbox,
                  },
                }),
              );
              checks.push(
                toDoctorCheck({
                  id: "state.openclawHookHealth",
                  label: "OpenClaw hook health",
                  status:
                    connectorStatus.openclawHook?.lastAttemptStatus ===
                      "failed" && inboxPendingCount > 0
                      ? "fail"
                      : "pass",
                  message:
                    connectorStatus.openclawHook?.lastAttemptStatus ===
                      "failed" && inboxPendingCount > 0
                      ? `connector replay to local OpenClaw hook is failing: ${replayError ?? "unknown error"}`
                      : "connector replay to local OpenClaw hook is healthy",
                  remediationHint:
                    connectorStatus.openclawHook?.lastAttemptStatus ===
                      "failed" && inboxPendingCount > 0
                      ? OPENCLAW_SETUP_RESTART_COMMAND_HINT
                      : undefined,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                    ...connectorStatus.openclawHook,
                    inboxPendingCount,
                  },
                }),
              );
            } else {
              const reason =
                connectorStatus.reason ?? "connector runtime is unavailable";
              checks.push(
                toDoctorCheck({
                  id: "state.connectorRuntime",
                  label: "Connector runtime",
                  status: "fail",
                  message: `connector runtime is not ready: ${reason}`,
                  remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                  },
                }),
              );
              checks.push(
                toDoctorCheck({
                  id: "state.connectorInboundInbox",
                  label: "Connector inbound inbox",
                  status: "fail",
                  message: `unable to read connector inbound inbox status: ${reason}`,
                  remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                  },
                }),
              );
              checks.push(
                toDoctorCheck({
                  id: "state.openclawHookHealth",
                  label: "OpenClaw hook health",
                  status: "fail",
                  message: `unable to verify OpenClaw hook health: ${reason}`,
                  remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
                  details: {
                    connectorStatusUrl: connectorStatus.statusUrl,
                    connectorBaseUrl: assignment.connectorBaseUrl,
                  },
                }),
              );
            }
          }
        }
      } catch {
        checks.push(
          toDoctorCheck({
            id: "state.connectorRuntime",
            label: "Connector runtime",
            status: "fail",
            message: `unable to read connector assignments at ${connectorAssignmentsPath}`,
            remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
            details: { connectorAssignmentsPath },
          }),
        );
        checks.push(
          toDoctorCheck({
            id: "state.connectorInboundInbox",
            label: "Connector inbound inbox",
            status: "fail",
            message:
              "cannot validate connector inbound inbox without connector assignment",
            remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
          }),
        );
        checks.push(
          toDoctorCheck({
            id: "state.openclawHookHealth",
            label: "OpenClaw hook health",
            status: "fail",
            message:
              "cannot validate OpenClaw hook health without connector assignment",
            remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
          }),
        );
      }
    }
  }

  return toDoctorResult(checks);
}

function parseRelayProbeFailure(input: {
  status: number;
  responseBody: string;
}): Pick<OpenclawRelayTestResult, "message" | "remediationHint"> {
  if (input.status === 401 || input.status === 403) {
    return {
      message: "OpenClaw hook token was rejected",
      remediationHint:
        "Pass a valid token with --hook-token or set OPENCLAW_HOOK_TOKEN",
    };
  }

  if (input.status === 404) {
    return {
      message: "OpenClaw send-to-peer hook is unavailable",
      remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
    };
  }

  if (input.status === 405) {
    return {
      message: "OpenClaw send-to-peer hook is not enabled for POST requests",
      remediationHint: `${OPENCLAW_SETUP_COMMAND_HINT}, then restart OpenClaw`,
    };
  }

  if (input.status === 500) {
    return {
      message: "Relay probe failed inside local relay pipeline",
      remediationHint:
        "Check peer pairing and rerun: clawdentity openclaw setup <agentName>",
    };
  }

  return {
    message: `Relay probe failed with HTTP ${input.status}`,
    remediationHint:
      input.responseBody.trim().length > 0
        ? `Inspect response body: ${input.responseBody.trim()}`
        : "Check local OpenClaw and connector logs",
  };
}

async function resolveRelayProbePeerAlias(input: {
  homeDir: string;
  peerAliasOption?: string;
}): Promise<string> {
  if (
    typeof input.peerAliasOption === "string" &&
    input.peerAliasOption.trim().length > 0
  ) {
    return parsePeerAlias(input.peerAliasOption);
  }

  const peersPath = resolvePeersPath(input.homeDir);
  const peersConfig = await loadPeersConfig(peersPath);
  const peerAliases = Object.keys(peersConfig.peers);

  if (peerAliases.length === 1) {
    return peerAliases[0];
  }

  if (peerAliases.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_RELAY_TEST_PEER_REQUIRED",
      "No paired peer is configured yet. Complete QR pairing first.",
      { peersPath },
    );
  }

  throw createCliError(
    "CLI_OPENCLAW_RELAY_TEST_PEER_REQUIRED",
    "Multiple peers are configured. Pass --peer <alias> to choose one.",
    { peersPath, peerAliases },
  );
}

export async function runOpenclawRelayTest(
  options: OpenclawRelayTestOptions,
): Promise<OpenclawRelayTestResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const checkedAt = nowIso();
  let peerAlias: string;
  try {
    peerAlias = await resolveRelayProbePeerAlias({
      homeDir,
      peerAliasOption: options.peer,
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    return {
      status: "failure",
      checkedAt,
      peerAlias: "unresolved",
      endpoint: toSendToPeerEndpoint(DEFAULT_OPENCLAW_BASE_URL),
      message: appError?.message ?? "Unable to resolve relay peer alias",
      remediationHint: OPENCLAW_PAIRING_COMMAND_HINT,
      details: appError?.details as Record<string, unknown> | undefined,
    };
  }

  const preflight = await runOpenclawDoctor({
    homeDir,
    openclawDir,
    peerAlias,
    resolveConfigImpl: options.resolveConfigImpl,
    includeConnectorRuntimeCheck: false,
  });

  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  let openclawBaseUrl = DEFAULT_OPENCLAW_BASE_URL;
  try {
    openclawBaseUrl = await resolveOpenclawBaseUrl({
      optionValue: options.openclawBaseUrl,
      relayRuntimeConfigPath,
    });
  } catch {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint: toSendToPeerEndpoint(DEFAULT_OPENCLAW_BASE_URL),
      message: "Unable to resolve OpenClaw base URL",
      remediationHint:
        "Set OPENCLAW_BASE_URL or run openclaw setup with --openclaw-base-url",
      preflight,
    };
  }

  const endpoint = toSendToPeerEndpoint(openclawBaseUrl);
  if (preflight.status === "unhealthy") {
    const firstFailure = preflight.checks.find(
      (check) => check.status === "fail",
    );
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message:
        firstFailure === undefined
          ? "Preflight checks failed"
          : `Preflight failed: ${firstFailure.label}`,
      remediationHint: firstFailure?.remediationHint,
      preflight,
    };
  }

  const hookToken = await resolveHookToken({
    optionValue: options.hookToken,
    relayRuntimeConfigPath,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message: "fetch implementation is unavailable",
      remediationHint: "Run relay test in a Node runtime with fetch support",
      preflight,
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(hookToken === undefined ? {} : { "x-openclaw-token": hookToken }),
      },
      body: JSON.stringify({
        peer: peerAlias,
        sessionId: resolveProbeSessionId(options.sessionId),
        message: resolveProbeMessage(options.message),
      }),
    });
  } catch {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      endpoint,
      message: "Relay probe request failed",
      remediationHint: "Ensure local OpenClaw is running and reachable",
      preflight,
    };
  }

  if (response.ok) {
    return {
      status: "success",
      checkedAt,
      peerAlias,
      endpoint,
      httpStatus: response.status,
      message: "Relay probe accepted",
      preflight,
    };
  }

  const responseBody = await response.text();
  const failure = parseRelayProbeFailure({
    status: response.status,
    responseBody,
  });
  return {
    status: "failure",
    checkedAt,
    peerAlias,
    endpoint,
    httpStatus: response.status,
    message: failure.message,
    remediationHint: failure.remediationHint,
    details:
      responseBody.trim().length > 0
        ? { responseBody: responseBody.trim() }
        : undefined,
    preflight,
  };
}

export function createOpenclawInviteCode(
  options: OpenclawInviteOptions,
): OpenclawInviteResult {
  const did = parseAgentDid(options.did, "invite did");
  const proxyUrl = parseProxyUrl(options.proxyUrl);
  const peerAlias =
    options.peerAlias === undefined
      ? undefined
      : parsePeerAlias(options.peerAlias);
  const agentName = parseOptionalProfileName(options.agentName, "agentName");
  const humanName = parseOptionalProfileName(options.humanName, "humanName");

  const payload = parseInvitePayload({
    v: 1,
    issuedAt: nowIso(),
    did,
    proxyUrl,
    alias: peerAlias,
    agentName,
    humanName,
  });

  const result: OpenclawInviteResult = {
    code: encodeInvitePayload(payload),
    did: payload.did,
    proxyUrl: payload.proxyUrl,
    peerAlias: payload.alias,
    agentName: payload.agentName,
    humanName: payload.humanName,
  };

  return result;
}

export function decodeOpenclawInviteCode(code: string): OpenclawInvitePayload {
  return decodeInvitePayload(code);
}

export async function setupOpenclawRelay(
  agentName: string,
  options: OpenclawSetupOptions,
): Promise<OpenclawSetupResult> {
  const normalizedAgentName = assertValidAgentName(agentName);
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const openclawConfigPath = resolveOpenclawConfigPath(openclawDir, homeDir);
  const transformSource =
    typeof options.transformSource === "string" &&
    options.transformSource.trim().length > 0
      ? options.transformSource.trim()
      : resolveDefaultTransformSource(openclawDir);
  const transformTargetPath = resolveTransformTargetPath(openclawDir);
  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(homeDir);
  const existingRelayRuntimeConfig = await loadRelayRuntimeConfig(
    relayRuntimeConfigPath,
  );
  const openclawBaseUrl = await resolveOpenclawBaseUrl({
    optionValue: options.openclawBaseUrl,
    relayRuntimeConfigPath,
  });

  await ensureLocalAgentCredentials(homeDir, normalizedAgentName);
  await mkdir(dirname(transformTargetPath), { recursive: true });
  try {
    await copyFile(transformSource, transformTargetPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_OPENCLAW_TRANSFORM_NOT_FOUND",
        "Relay transform source file was not found",
        { transformSource },
      );
    }

    throw error;
  }

  const patchedOpenclawConfig = await patchOpenclawConfig(
    openclawConfigPath,
    existingRelayRuntimeConfig?.openclawHookToken,
  );

  const peersPath = resolvePeersPath(homeDir);
  const peers = await loadPeersConfig(peersPath);
  await savePeersConfig(peersPath, peers);

  const relayTransformPeersPath = resolveTransformPeersPath(openclawDir);
  await writeSecureFile(
    relayTransformPeersPath,
    `${JSON.stringify(peers, null, 2)}\n`,
  );

  const connectorAssignmentsPath = resolveConnectorAssignmentsPath(homeDir);
  const connectorAssignments = await loadConnectorAssignments(
    connectorAssignmentsPath,
  );
  const connectorPort = allocateConnectorPort(
    connectorAssignments,
    normalizedAgentName,
  );
  const connectorBaseUrl = buildConnectorBaseUrl(
    CONNECTOR_HOST_LOOPBACK,
    connectorPort,
  );
  connectorAssignments.agents[normalizedAgentName] = {
    connectorBaseUrl,
    updatedAt: nowIso(),
  };
  await saveConnectorAssignments(
    connectorAssignmentsPath,
    connectorAssignments,
  );

  const relayTransformRuntimePath = resolveTransformRuntimePath(openclawDir);
  await writeSecureFile(
    relayTransformRuntimePath,
    `${JSON.stringify(
      {
        version: 1,
        connectorBaseUrl: buildRelayConnectorBaseUrls(connectorPort)[0],
        connectorBaseUrls: buildRelayConnectorBaseUrls(connectorPort),
        connectorPath: DEFAULT_CONNECTOR_OUTBOUND_PATH,
        peersConfigPath: RELAY_PEERS_FILE_NAME,
        updatedAt: nowIso(),
      },
      null,
      2,
    )}\n`,
  );

  const agentNamePath = resolveOpenclawAgentNamePath(homeDir);
  await writeSecureFile(agentNamePath, `${normalizedAgentName}\n`);
  await saveRelayRuntimeConfig(
    relayRuntimeConfigPath,
    openclawBaseUrl,
    patchedOpenclawConfig.hookToken,
    relayTransformPeersPath,
  );

  logger.info("cli.openclaw_setup_completed", {
    agentName: normalizedAgentName,
    openclawConfigPath,
    transformTargetPath,
    relayTransformRuntimePath,
    relayTransformPeersPath,
    openclawBaseUrl,
    connectorBaseUrl,
    relayRuntimeConfigPath,
  });

  return {
    openclawConfigPath,
    transformTargetPath,
    relayTransformRuntimePath,
    relayTransformPeersPath,
    openclawBaseUrl,
    connectorBaseUrl,
    relayRuntimeConfigPath,
    openclawConfigChanged: patchedOpenclawConfig.configChanged,
  };
}

async function assertSetupChecklistHealthy(input: {
  homeDir: string;
  openclawDir: string;
  includeConnectorRuntimeCheck: boolean;
  gatewayDeviceApprovalRunner?: OpenclawGatewayDeviceApprovalRunner;
}): Promise<void> {
  let checklist = await runOpenclawDoctor({
    homeDir: input.homeDir,
    openclawDir: input.openclawDir,
    includeConfigCheck: false,
    includeConnectorRuntimeCheck: input.includeConnectorRuntimeCheck,
  });

  if (checklist.status === "healthy") {
    return;
  }

  let gatewayApprovalSummary: OpenclawGatewayDeviceApprovalSummary | undefined;
  const gatewayPairingFailure = checklist.checks.find(
    (check) =>
      check.id === "state.gatewayDevicePairing" && check.status === "fail",
  );
  if (gatewayPairingFailure !== undefined) {
    gatewayApprovalSummary = await autoApproveOpenclawGatewayDevices({
      homeDir: input.homeDir,
      openclawDir: input.openclawDir,
      runner: input.gatewayDeviceApprovalRunner,
    });
    if (gatewayApprovalSummary !== undefined) {
      const successfulAttempts = gatewayApprovalSummary.attempts.filter(
        (attempt) => attempt.ok,
      ).length;
      const failedAttempts = gatewayApprovalSummary.attempts.filter(
        (attempt) => !attempt.ok,
      );
      logger.info("cli.openclaw_setup_gateway_device_recovery_attempted", {
        openclawDir: input.openclawDir,
        pendingCount: gatewayApprovalSummary.pendingRequestIds.length,
        successfulAttempts,
        failedAttempts: failedAttempts.length,
        commandUnavailable: failedAttempts.some(
          (attempt) => attempt.unavailable,
        ),
      });
      checklist = await runOpenclawDoctor({
        homeDir: input.homeDir,
        openclawDir: input.openclawDir,
        includeConfigCheck: false,
        includeConnectorRuntimeCheck: input.includeConnectorRuntimeCheck,
      });
      if (checklist.status === "healthy") {
        return;
      }
    }
  }

  const firstFailure = checklist.checks.find(
    (check) => check.status === "fail",
  );
  const unavailableGatewayApprovalAttempt =
    gatewayApprovalSummary?.attempts.find((attempt) => attempt.unavailable);
  const remediationHint =
    unavailableGatewayApprovalAttempt !== undefined &&
    firstFailure?.id === "state.gatewayDevicePairing"
      ? `${OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT}. Ensure the \`${resolveOpenclawGatewayApprovalCommand()}\` command is available.`
      : firstFailure?.remediationHint;
  throw createCliError(
    "CLI_OPENCLAW_SETUP_CHECKLIST_FAILED",
    "OpenClaw setup checklist failed",
    {
      firstFailedCheckId: firstFailure?.id,
      firstFailedCheckMessage: firstFailure?.message,
      remediationHint,
      gatewayDeviceApproval: gatewayApprovalSummary,
      checks: checklist.checks,
    },
  );
}

export async function setupOpenclawSelfReady(
  agentName: string,
  options: OpenclawSetupOptions,
): Promise<OpenclawSelfSetupResult> {
  const normalizedAgentName = assertValidAgentName(agentName);
  const resolvedHomeDir = resolveHomeDir(options.homeDir);
  const resolvedOpenclawDir = resolveOpenclawDir(
    options.openclawDir,
    resolvedHomeDir,
  );
  const setup = await setupOpenclawRelay(normalizedAgentName, {
    ...options,
    homeDir: resolvedHomeDir,
    openclawDir: resolvedOpenclawDir,
  });
  if (options.noRuntimeStart === true) {
    await assertSetupChecklistHealthy({
      homeDir: resolvedHomeDir,
      openclawDir: resolvedOpenclawDir,
      includeConnectorRuntimeCheck: false,
      gatewayDeviceApprovalRunner: options.gatewayDeviceApprovalRunner,
    });
    return {
      ...setup,
      runtimeMode: "none",
      runtimeStatus: "skipped",
      websocketStatus: "skipped",
    };
  }

  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createCliError(
      "CLI_OPENCLAW_SETUP_FETCH_UNAVAILABLE",
      "Runtime fetch is unavailable for connector readiness checks",
    );
  }

  const resolvedMode = parseOpenclawRuntimeMode(options.runtimeMode);
  const waitTimeoutSeconds = parseWaitTimeoutSeconds(
    options.waitTimeoutSeconds,
  );
  let runtime = await startSetupConnectorRuntime({
    agentName: normalizedAgentName,
    homeDir: resolvedHomeDir,
    openclawBaseUrl: setup.openclawBaseUrl,
    connectorBaseUrl: setup.connectorBaseUrl,
    mode: resolvedMode,
    waitTimeoutSeconds,
    fetchImpl,
  });

  await assertSetupChecklistHealthy({
    homeDir: resolvedHomeDir,
    openclawDir: resolvedOpenclawDir,
    includeConnectorRuntimeCheck: true,
    gatewayDeviceApprovalRunner: options.gatewayDeviceApprovalRunner,
  });

  const requiresStabilityGuard =
    setup.openclawConfigChanged &&
    (runtime.runtimeMode === "existing" || runtime.runtimeMode === "detached");
  if (requiresStabilityGuard) {
    const stabilityWindowSeconds = Math.min(
      waitTimeoutSeconds,
      OPENCLAW_SETUP_STABILITY_WINDOW_SECONDS,
    );
    const stableStatus = await monitorConnectorStabilityWindow({
      connectorBaseUrl: setup.connectorBaseUrl,
      fetchImpl,
      durationSeconds: stabilityWindowSeconds,
      pollIntervalMs: OPENCLAW_SETUP_STABILITY_POLL_INTERVAL_MS,
    });

    if (!stableStatus.connected) {
      logger.warn("cli.openclaw.setup.connector_dropped_post_config_change", {
        agentName: normalizedAgentName,
        connectorBaseUrl: setup.connectorBaseUrl,
        connectorStatusUrl: stableStatus.statusUrl,
        reason: stableStatus.reason,
        previousRuntimeMode: runtime.runtimeMode,
        stabilityWindowSeconds,
      });
      runtime = await startSetupConnectorRuntime({
        agentName: normalizedAgentName,
        homeDir: resolvedHomeDir,
        openclawBaseUrl: setup.openclawBaseUrl,
        connectorBaseUrl: setup.connectorBaseUrl,
        mode: resolvedMode,
        waitTimeoutSeconds,
        fetchImpl,
      });
      await assertSetupChecklistHealthy({
        homeDir: resolvedHomeDir,
        openclawDir: resolvedOpenclawDir,
        includeConnectorRuntimeCheck: true,
        gatewayDeviceApprovalRunner: options.gatewayDeviceApprovalRunner,
      });
    }
  }

  return {
    ...setup,
    ...runtime,
  };
}

export async function setupOpenclawRelayFromInvite(
  agentName: string,
  options: OpenclawSetupOptions,
): Promise<OpenclawSetupResult> {
  return setupOpenclawRelay(agentName, options);
}

export const createOpenclawCommand = (): Command => {
  const openclawCommand = new Command("openclaw").description(
    "Manage OpenClaw relay setup",
  );

  openclawCommand
    .command("setup <agentName>")
    .description("Apply OpenClaw relay setup")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option(
      "--transform-source <path>",
      "Path to relay-to-peer.mjs (default <openclaw-dir>/skills/clawdentity-openclaw-relay/relay-to-peer.mjs)",
    )
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default http://127.0.0.1:18789)",
    )
    .option(
      "--runtime-mode <mode>",
      "Connector runtime mode: auto | service | detached (default auto)",
    )
    .option(
      "--wait-timeout-seconds <seconds>",
      "Seconds to wait for connector websocket readiness (default 30)",
    )
    .option(
      "--no-runtime-start",
      "Skip connector runtime startup (advanced/manual mode)",
    )
    .action(
      withErrorHandling(
        "openclaw setup",
        async (agentName: string, options: OpenclawSetupCommandOptions) => {
          const result = await setupOpenclawSelfReady(agentName, options);
          writeStdoutLine("Self setup complete");
          writeStdoutLine(
            `Updated OpenClaw config: ${result.openclawConfigPath}`,
          );
          writeStdoutLine(`Installed transform: ${result.transformTargetPath}`);
          writeStdoutLine(
            `Transform runtime config: ${result.relayTransformRuntimePath}`,
          );
          writeStdoutLine(
            `Transform peers snapshot: ${result.relayTransformPeersPath}`,
          );
          writeStdoutLine(`Connector base URL: ${result.connectorBaseUrl}`);
          writeStdoutLine(`OpenClaw base URL: ${result.openclawBaseUrl}`);
          writeStdoutLine(
            `Relay runtime config: ${result.relayRuntimeConfigPath}`,
          );
          writeStdoutLine(`Runtime mode: ${result.runtimeMode}`);
          writeStdoutLine(`Runtime status: ${result.runtimeStatus}`);
          writeStdoutLine(`WebSocket status: ${result.websocketStatus}`);
          if (result.connectorStatusUrl) {
            writeStdoutLine(
              `Connector status URL: ${result.connectorStatusUrl}`,
            );
          }
        },
      ),
    );

  openclawCommand
    .command("doctor")
    .description("Validate local OpenClaw relay setup and print remediation")
    .option("--peer <alias>", "Validate that a specific peer alias exists")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw doctor",
        async (options: OpenclawDoctorCommandOptions) => {
          const result = await runOpenclawDoctor({
            openclawDir: options.openclawDir,
            peerAlias: options.peer,
            json: options.json,
          });
          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printDoctorResult(result);
          }

          if (result.status === "unhealthy") {
            process.exitCode = 1;
          }
        },
      ),
    );

  const relayCommand = openclawCommand
    .command("relay")
    .description("Run OpenClaw relay diagnostics");

  relayCommand
    .command("test")
    .description(
      "Send a relay probe to a configured peer (auto-selects when one peer exists)",
    )
    .option("--peer <alias>", "Peer alias in local peers map")
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default OPENCLAW_BASE_URL or relay runtime config)",
    )
    .option(
      "--hook-token <token>",
      "OpenClaw hook token (default OPENCLAW_HOOK_TOKEN)",
    )
    .option("--session-id <id>", "Session id for the probe payload")
    .option("--message <text>", "Probe message body")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw relay test",
        async (options: OpenclawRelayTestOptions) => {
          const result = await runOpenclawRelayTest(options);

          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printRelayTestResult(result);
            if (
              result.preflight !== undefined &&
              result.preflight.status === "unhealthy"
            ) {
              writeStdoutLine("Preflight details:");
              for (const check of result.preflight.checks) {
                if (check.status === "fail") {
                  writeStdoutLine(formatDoctorCheckLine(check));
                  if (check.remediationHint) {
                    writeStdoutLine(`Fix: ${check.remediationHint}`);
                  }
                }
              }
            }
          }

          if (result.status === "failure") {
            process.exitCode = 1;
          }
        },
      ),
    );

  return openclawCommand;
};
