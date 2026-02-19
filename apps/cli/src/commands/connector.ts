import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startConnectorRuntime as bundledStartConnectorRuntime } from "@clawdentity/connector";
import { AppError, createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import { getConfigDir, resolveConfig } from "../config/manager.js";
import { fetchRegistryMetadata } from "../config/registry-metadata.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "connector" });
const execFile = promisify(execFileCallback);

const AGENTS_DIR_NAME = "agents";
const IDENTITY_FILE_NAME = "identity.json";
const AIT_FILE_NAME = "ait.jwt";
const SECRET_KEY_FILE_NAME = "secret.key";
const REGISTRY_AUTH_FILE_NAME = "registry-auth.json";
const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
const OPENCLAW_CONNECTORS_FILE_NAME = "openclaw-connectors.json";
const SERVICE_LOG_DIR_NAME = "logs";

const DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";

type ConnectorCredentials = {
  accessToken?: string;
  accessExpiresAt?: string;
  agentDid: string;
  ait: string;
  refreshToken: string;
  refreshExpiresAt?: string;
  secretKey: string;
  tokenType?: "Bearer";
};

type ConnectorStartInput = {
  agentName: string;
  configDir: string;
  credentials: ConnectorCredentials;
  openclawBaseUrl?: string;
  openclawHookPath?: string;
  openclawHookToken?: string;
  outboundBaseUrl: string;
  outboundPath: string;
  proxyWebsocketUrl?: string;
  registryUrl: string;
};

type ConnectorRuntime = {
  closed?: Promise<void>;
  outboundUrl?: string;
  proxyWebsocketUrl?: string;
  waitForStop?: () => Promise<void>;
  waitUntilStopped?: () => Promise<void>;
  websocketUrl?: string;
};

type ConnectorModule = {
  startConnectorRuntime?: (
    input: ConnectorStartInput,
  ) => Promise<ConnectorRuntime | undefined>;
};

type ReadFileText = (path: string, encoding: "utf8") => Promise<string>;
type ResolveConfigLike = () => Promise<{
  registryUrl: string;
  proxyUrl?: string;
}>;
type ExecFileLike = (
  file: string,
  args?: readonly string[],
) => Promise<{ stderr: string; stdout: string }>;
type MkdirLike = (
  path: string,
  options?: { recursive?: boolean },
) => Promise<void>;
type WriteFileLike = (
  filePath: string,
  data: string,
  encoding: "utf8",
) => Promise<void>;
type RemoveFileLike = (
  filePath: string,
  options?: { force?: boolean },
) => Promise<void>;
type ResolveHomeDirLike = () => string;
type ResolveNodeExecPathLike = () => string;
type ResolveCurrentPlatformLike = () => NodeJS.Platform;
type ResolveCurrentModulePathLike = () => string;
type ResolveCurrentUidLike = () => number;

type ConnectorCommandDependencies = {
  execFileImpl?: ExecFileLike;
  fetchImpl?: typeof fetch;
  getConfigDirImpl?: typeof getConfigDir;
  getHomeDirImpl?: ResolveHomeDirLike;
  loadConnectorModule?: () => Promise<ConnectorModule>;
  mkdirImpl?: MkdirLike;
  readFileImpl?: ReadFileText;
  removeFileImpl?: RemoveFileLike;
  resolveCurrentModulePathImpl?: ResolveCurrentModulePathLike;
  resolveCurrentPlatformImpl?: ResolveCurrentPlatformLike;
  resolveCurrentUidImpl?: ResolveCurrentUidLike;
  resolveConfigImpl?: ResolveConfigLike;
  resolveNodeExecPathImpl?: ResolveNodeExecPathLike;
  writeFileImpl?: WriteFileLike;
};

type ConnectorStartCommandOptions = {
  openclawBaseUrl?: string;
  openclawHookPath?: string;
  openclawHookToken?: string;
  proxyWsUrl?: string;
};

type ConnectorServicePlatform = "launchd" | "systemd";

type ConnectorServiceInstallCommandOptions = ConnectorStartCommandOptions & {
  platform?: "auto" | ConnectorServicePlatform;
};

type ConnectorServiceUninstallCommandOptions = {
  platform?: "auto" | ConnectorServicePlatform;
};

export type ConnectorStartResult = {
  outboundUrl: string;
  proxyWebsocketUrl?: string;
  runtime?: ConnectorRuntime | undefined;
};

type OpenclawRelayRuntimeConfig = {
  openclawHookToken?: string;
};

export type ConnectorServiceInstallResult = {
  serviceFilePath: string;
  serviceName: string;
  platform: ConnectorServicePlatform;
};

export type ConnectorServiceUninstallResult = {
  serviceFilePath: string;
  serviceName: string;
  platform: ConnectorServicePlatform;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
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

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_INPUT",
      "Connector input is invalid",
      {
        label,
      },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_INPUT",
      "Connector input is invalid",
      {
        label,
      },
    );
  }

  return trimmed;
}

function parseAgentDid(value: unknown): string {
  const did = parseNonEmptyString(value, "agent did");
  if (!did.startsWith("did:claw:agent:")) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_AGENT_IDENTITY",
      "Agent identity is invalid for connector startup",
    );
  }

  return did;
}

function parseConnectorBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_BASE_URL",
      "Connector base URL is invalid",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_BASE_URL",
      "Connector base URL is invalid",
    );
  }

  if (
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  ) {
    return parsed.origin;
  }

  return parsed.toString();
}

function parseProxyWebsocketUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_PROXY_URL",
      "Proxy websocket URL is invalid",
    );
  }

  if (
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_PROXY_URL",
      "Proxy websocket URL is invalid",
    );
  }

  return parsed.toString();
}

function resolveProxyWebsocketUrlFromEnv(): string | undefined {
  const explicitProxyWsUrl = process.env.CLAWDENTITY_PROXY_WS_URL;
  if (
    typeof explicitProxyWsUrl === "string" &&
    explicitProxyWsUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(explicitProxyWsUrl.trim());
  }

  const proxyUrl = process.env.CLAWDENTITY_PROXY_URL;
  if (typeof proxyUrl === "string" && proxyUrl.trim().length > 0) {
    return parseProxyWebsocketUrl(proxyUrl.trim());
  }

  return undefined;
}

async function resolveProxyWebsocketUrl(input: {
  explicitProxyWsUrl?: string;
  configProxyUrl?: string;
  registryUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (
    typeof input.explicitProxyWsUrl === "string" &&
    input.explicitProxyWsUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(input.explicitProxyWsUrl.trim());
  }

  const fromEnv = resolveProxyWebsocketUrlFromEnv();
  if (fromEnv !== undefined) {
    return fromEnv;
  }

  if (
    typeof input.configProxyUrl === "string" &&
    input.configProxyUrl.trim().length > 0
  ) {
    return parseProxyWebsocketUrl(input.configProxyUrl.trim());
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl === "function") {
    try {
      const metadata = await fetchRegistryMetadata(input.registryUrl, {
        fetchImpl,
      });
      return parseProxyWebsocketUrl(metadata.proxyUrl);
    } catch {
      // Fall through to deterministic operator guidance below.
    }
  }

  throw createCliError(
    "CLI_CONNECTOR_PROXY_URL_REQUIRED",
    "Proxy URL is required for connector startup. Run `clawdentity invite redeem <clw_inv_...>` or set CLAWDENTITY_PROXY_URL / CLAWDENTITY_PROXY_WS_URL.",
  );
}

function normalizeOutboundPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_OUTBOUND_PATH",
      "Connector outbound path is invalid",
    );
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConnectorBaseUrlFromEnv(): string | undefined {
  const value = process.env.CLAWDENTITY_CONNECTOR_BASE_URL;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return parseConnectorBaseUrl(value.trim());
}

async function readConnectorAssignedBaseUrl(
  configDir: string,
  agentName: string,
  readFileImpl: ReadFileText,
): Promise<string | undefined> {
  const assignmentsPath = join(configDir, OPENCLAW_CONNECTORS_FILE_NAME);
  let raw: string;
  try {
    raw = await readFileImpl(assignmentsPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_ASSIGNMENTS",
      "Connector assignments config is invalid JSON",
      { assignmentsPath },
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.agents)) {
    return undefined;
  }

  const entry = parsed.agents[agentName];
  if (!isRecord(entry) || typeof entry.connectorBaseUrl !== "string") {
    return undefined;
  }

  return parseConnectorBaseUrl(entry.connectorBaseUrl);
}

function resolveConnectorOutboundPath(): string {
  const value = process.env.CLAWDENTITY_CONNECTOR_OUTBOUND_PATH;
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_CONNECTOR_OUTBOUND_PATH;
  }

  return normalizeOutboundPath(value);
}

function resolveOutboundUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

async function readRequiredTrimmedFile(
  filePath: string,
  label: string,
  readFileImpl: ReadFileText,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFileImpl(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_CONNECTOR_MISSING_AGENT_MATERIAL",
        "Local agent credentials are missing for connector startup",
        { label },
      );
    }

    throw error;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_MISSING_AGENT_MATERIAL",
      "Local agent credentials are missing for connector startup",
      { label },
    );
  }

  return trimmed;
}

async function readRelayRuntimeConfig(
  configDir: string,
  readFileImpl: ReadFileText,
): Promise<OpenclawRelayRuntimeConfig | undefined> {
  const filePath = join(configDir, OPENCLAW_RELAY_RUNTIME_FILE_NAME);
  let raw: string;
  try {
    raw = await readFileImpl(filePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const openclawHookToken =
    typeof parsed.openclawHookToken === "string" &&
    parsed.openclawHookToken.trim().length > 0
      ? parsed.openclawHookToken.trim()
      : undefined;
  if (!openclawHookToken) {
    return undefined;
  }

  return {
    openclawHookToken,
  };
}

function parseJsonRecord(
  value: string,
  code: string,
  message: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw createCliError(code, message);
  }

  if (!isRecord(parsed)) {
    throw createCliError(code, message);
  }

  return parsed;
}

function parseRegistryAuth(
  rawRegistryAuth: string,
): Pick<
  ConnectorCredentials,
  | "accessToken"
  | "accessExpiresAt"
  | "refreshToken"
  | "refreshExpiresAt"
  | "tokenType"
> {
  const parsed = parseJsonRecord(
    rawRegistryAuth,
    "CLI_CONNECTOR_INVALID_REGISTRY_AUTH",
    "Agent registry auth is invalid for connector startup",
  );

  const refreshToken = parseNonEmptyString(parsed.refreshToken, "refreshToken");
  const accessToken =
    typeof parsed.accessToken === "string" &&
    parsed.accessToken.trim().length > 0
      ? parsed.accessToken.trim()
      : undefined;
  const accessExpiresAt =
    typeof parsed.accessExpiresAt === "string" &&
    parsed.accessExpiresAt.trim().length > 0
      ? parsed.accessExpiresAt.trim()
      : undefined;
  const refreshExpiresAt =
    typeof parsed.refreshExpiresAt === "string" &&
    parsed.refreshExpiresAt.trim().length > 0
      ? parsed.refreshExpiresAt.trim()
      : undefined;
  const tokenType = parsed.tokenType === "Bearer" ? "Bearer" : undefined;

  return {
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
    tokenType,
  };
}

function parseAgentIdentity(rawIdentity: string): { did: string } {
  const parsed = parseJsonRecord(
    rawIdentity,
    "CLI_CONNECTOR_INVALID_AGENT_IDENTITY",
    "Agent identity is invalid for connector startup",
  );

  return {
    did: parseAgentDid(parsed.did),
  };
}

async function loadDefaultConnectorModule(): Promise<ConnectorModule> {
  return {
    startConnectorRuntime: bundledStartConnectorRuntime,
  };
}

function resolveWaitPromise(
  runtime: ConnectorRuntime | undefined,
): Promise<void> | undefined {
  if (!runtime || !isRecord(runtime)) {
    return undefined;
  }

  if (typeof runtime.waitUntilStopped === "function") {
    return runtime.waitUntilStopped();
  }

  if (typeof runtime.waitForStop === "function") {
    return runtime.waitForStop();
  }

  if (runtime.closed instanceof Promise) {
    return runtime.closed.then(() => undefined);
  }

  return undefined;
}

function sanitizeServiceSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]+/g, "-");
}

function parseConnectorServicePlatformOption(
  value: unknown,
): "auto" | ConnectorServicePlatform {
  if (value === undefined) {
    return "auto";
  }

  if (value === "auto" || value === "launchd" || value === "systemd") {
    return value;
  }

  throw createCliError(
    "CLI_CONNECTOR_SERVICE_PLATFORM_INVALID",
    "Connector service platform must be one of: auto, launchd, systemd",
  );
}

function resolveConnectorServicePlatform(
  inputPlatform: "auto" | ConnectorServicePlatform | undefined,
  currentPlatform: NodeJS.Platform,
): ConnectorServicePlatform {
  if (inputPlatform && inputPlatform !== "auto") {
    return inputPlatform;
  }

  if (currentPlatform === "darwin") {
    return "launchd";
  }

  if (currentPlatform === "linux") {
    return "systemd";
  }

  throw createCliError(
    "CLI_CONNECTOR_SERVICE_PLATFORM_UNSUPPORTED",
    "Connector service install is supported only on macOS (launchd) and Linux (systemd)",
    {
      platform: currentPlatform,
    },
  );
}

function buildConnectorStartArgs(
  agentName: string,
  commandOptions: ConnectorStartCommandOptions,
): string[] {
  const args = ["connector", "start", agentName];

  if (commandOptions.proxyWsUrl) {
    args.push("--proxy-ws-url", commandOptions.proxyWsUrl);
  }

  if (commandOptions.openclawBaseUrl) {
    args.push("--openclaw-base-url", commandOptions.openclawBaseUrl);
  }

  if (commandOptions.openclawHookPath) {
    args.push("--openclaw-hook-path", commandOptions.openclawHookPath);
  }

  if (commandOptions.openclawHookToken) {
    args.push("--openclaw-hook-token", commandOptions.openclawHookToken);
  }

  return args;
}

function resolveCliEntryPath(
  resolveCurrentModulePathImpl: ResolveCurrentModulePathLike | undefined,
): string {
  const modulePath =
    resolveCurrentModulePathImpl?.() ?? fileURLToPath(import.meta.url);
  return join(dirname(modulePath), "..", "bin.js");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemdArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function createSystemdServiceFileContent(input: {
  command: string[];
  description: string;
  errorLogPath: string;
  outputLogPath: string;
  workingDirectory: string;
}): string {
  const execStart = input.command.map(quoteSystemdArgument).join(" ");

  return [
    "[Unit]",
    `Description=${input.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=2",
    `WorkingDirectory=${quoteSystemdArgument(input.workingDirectory)}`,
    `StandardOutput=append:${input.outputLogPath}`,
    `StandardError=append:${input.errorLogPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function createLaunchdPlistContent(input: {
  command: string[];
  label: string;
  errorLogPath: string;
  outputLogPath: string;
  workingDirectory: string;
}): string {
  const commandItems = input.command
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    commandItems,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(input.workingDirectory)}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(input.outputLogPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(input.errorLogPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function resolveServiceDependencies(
  dependencies: ConnectorCommandDependencies,
) {
  const execFileImpl: ExecFileLike =
    dependencies.execFileImpl ??
    (async (file, args = []) => {
      const result = await execFile(file, [...args]);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });

  return {
    execFileImpl,
    getConfigDirImpl: dependencies.getConfigDirImpl ?? getConfigDir,
    getHomeDirImpl: dependencies.getHomeDirImpl ?? homedir,
    mkdirImpl: dependencies.mkdirImpl ?? mkdir,
    removeFileImpl: dependencies.removeFileImpl ?? rm,
    resolveCurrentModulePathImpl: dependencies.resolveCurrentModulePathImpl,
    resolveCurrentPlatformImpl:
      dependencies.resolveCurrentPlatformImpl ?? (() => process.platform),
    resolveCurrentUidImpl:
      dependencies.resolveCurrentUidImpl ??
      (() => {
        if (typeof process.getuid !== "function") {
          throw createCliError(
            "CLI_CONNECTOR_SERVICE_UID_UNAVAILABLE",
            "Current user id is unavailable in this runtime",
          );
        }
        return process.getuid();
      }),
    resolveNodeExecPathImpl:
      dependencies.resolveNodeExecPathImpl ?? (() => process.execPath),
    writeFileImpl: dependencies.writeFileImpl ?? writeFile,
  };
}

export async function installConnectorServiceForAgent(
  agentName: string,
  commandOptions: ConnectorServiceInstallCommandOptions = {},
  dependencies: ConnectorCommandDependencies = {},
): Promise<ConnectorServiceInstallResult> {
  const serviceDependencies = resolveServiceDependencies(dependencies);
  const servicePlatform = parseConnectorServicePlatformOption(
    commandOptions.platform,
  );
  const platform = resolveConnectorServicePlatform(
    servicePlatform,
    serviceDependencies.resolveCurrentPlatformImpl(),
  );
  const configDir = serviceDependencies.getConfigDirImpl();
  const homeDir = serviceDependencies.getHomeDirImpl();
  const logsDir = join(configDir, SERVICE_LOG_DIR_NAME);
  const serviceName = sanitizeServiceSegment(
    `clawdentity-connector-${agentName}`,
  );
  const startArgs = buildConnectorStartArgs(agentName, commandOptions);
  const command = [
    serviceDependencies.resolveNodeExecPathImpl(),
    resolveCliEntryPath(serviceDependencies.resolveCurrentModulePathImpl),
    ...startArgs,
  ];
  const outputLogPath = join(logsDir, `${serviceName}.out.log`);
  const errorLogPath = join(logsDir, `${serviceName}.err.log`);

  await serviceDependencies.mkdirImpl(logsDir, { recursive: true });

  if (platform === "systemd") {
    const serviceDir = join(homeDir, ".config", "systemd", "user");
    const serviceFilePath = join(serviceDir, `${serviceName}.service`);

    await serviceDependencies.mkdirImpl(serviceDir, { recursive: true });
    await serviceDependencies.writeFileImpl(
      serviceFilePath,
      createSystemdServiceFileContent({
        command,
        description: `Clawdentity connector (${agentName})`,
        outputLogPath,
        errorLogPath,
        workingDirectory: homeDir,
      }),
      "utf8",
    );

    try {
      await serviceDependencies.execFileImpl("systemctl", [
        "--user",
        "daemon-reload",
      ]);
      await serviceDependencies.execFileImpl("systemctl", [
        "--user",
        "enable",
        "--now",
        `${serviceName}.service`,
      ]);
    } catch (error) {
      throw createCliError(
        "CLI_CONNECTOR_SERVICE_INSTALL_FAILED",
        "Failed to install systemd connector service",
        {
          reason: error instanceof Error ? error.message : "unknown",
        },
      );
    }

    return {
      platform,
      serviceName,
      serviceFilePath,
    };
  }

  const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
  const serviceNameWithDomain = `com.clawdentity.${serviceName}`;
  const serviceFilePath = join(
    launchAgentsDir,
    `${serviceNameWithDomain}.plist`,
  );

  await serviceDependencies.mkdirImpl(launchAgentsDir, { recursive: true });
  await serviceDependencies.writeFileImpl(
    serviceFilePath,
    createLaunchdPlistContent({
      command,
      label: serviceNameWithDomain,
      outputLogPath,
      errorLogPath,
      workingDirectory: homeDir,
    }),
    "utf8",
  );

  try {
    await serviceDependencies.execFileImpl("launchctl", [
      "unload",
      "-w",
      serviceFilePath,
    ]);
  } catch {
    // Ignore unload failures for first install or already-unloaded service.
  }

  try {
    await serviceDependencies.execFileImpl("launchctl", [
      "load",
      "-w",
      serviceFilePath,
    ]);
  } catch (error) {
    throw createCliError(
      "CLI_CONNECTOR_SERVICE_INSTALL_FAILED",
      "Failed to install launchd connector service",
      {
        reason: error instanceof Error ? error.message : "unknown",
      },
    );
  }

  return {
    platform,
    serviceName: serviceNameWithDomain,
    serviceFilePath,
  };
}

export async function uninstallConnectorServiceForAgent(
  agentName: string,
  commandOptions: ConnectorServiceUninstallCommandOptions = {},
  dependencies: ConnectorCommandDependencies = {},
): Promise<ConnectorServiceUninstallResult> {
  const serviceDependencies = resolveServiceDependencies(dependencies);
  const servicePlatform = parseConnectorServicePlatformOption(
    commandOptions.platform,
  );
  const platform = resolveConnectorServicePlatform(
    servicePlatform,
    serviceDependencies.resolveCurrentPlatformImpl(),
  );
  const homeDir = serviceDependencies.getHomeDirImpl();
  const serviceName = sanitizeServiceSegment(
    `clawdentity-connector-${agentName}`,
  );

  if (platform === "systemd") {
    const serviceFilePath = join(
      homeDir,
      ".config",
      "systemd",
      "user",
      `${serviceName}.service`,
    );

    try {
      await serviceDependencies.execFileImpl("systemctl", [
        "--user",
        "disable",
        "--now",
        `${serviceName}.service`,
      ]);
    } catch {
      // Continue uninstall to keep command idempotent.
    }

    await serviceDependencies.removeFileImpl(serviceFilePath, { force: true });

    try {
      await serviceDependencies.execFileImpl("systemctl", [
        "--user",
        "daemon-reload",
      ]);
    } catch {
      // Continue uninstall; unit file is already removed.
    }

    return {
      platform,
      serviceName,
      serviceFilePath,
    };
  }

  const serviceNameWithDomain = `com.clawdentity.${serviceName}`;
  const serviceFilePath = join(
    homeDir,
    "Library",
    "LaunchAgents",
    `${serviceNameWithDomain}.plist`,
  );

  try {
    await serviceDependencies.execFileImpl("launchctl", [
      "unload",
      "-w",
      serviceFilePath,
    ]);
  } catch {
    // Continue uninstall to keep command idempotent.
  }

  await serviceDependencies.removeFileImpl(serviceFilePath, { force: true });

  return {
    platform,
    serviceName: serviceNameWithDomain,
    serviceFilePath,
  };
}

export async function startConnectorForAgent(
  agentName: string,
  commandOptions: ConnectorStartCommandOptions = {},
  dependencies: ConnectorCommandDependencies = {},
): Promise<ConnectorStartResult> {
  const resolveConfigImpl: ResolveConfigLike =
    dependencies.resolveConfigImpl ?? resolveConfig;
  const getConfigDirImpl = dependencies.getConfigDirImpl ?? getConfigDir;
  const readFileImpl: ReadFileText =
    dependencies.readFileImpl ?? ((path, encoding) => readFile(path, encoding));
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const loadConnectorModule =
    dependencies.loadConnectorModule ?? loadDefaultConnectorModule;
  const configDir = getConfigDirImpl();
  const agentDirectory = join(configDir, AGENTS_DIR_NAME, agentName);

  const [
    rawAit,
    rawSecretKey,
    rawIdentity,
    rawRegistryAuth,
    assignedConnectorBaseUrl,
    relayRuntimeConfig,
    config,
    connectorModule,
  ] = await Promise.all([
    readRequiredTrimmedFile(
      join(agentDirectory, AIT_FILE_NAME),
      AIT_FILE_NAME,
      readFileImpl,
    ),
    readRequiredTrimmedFile(
      join(agentDirectory, SECRET_KEY_FILE_NAME),
      SECRET_KEY_FILE_NAME,
      readFileImpl,
    ),
    readRequiredTrimmedFile(
      join(agentDirectory, IDENTITY_FILE_NAME),
      IDENTITY_FILE_NAME,
      readFileImpl,
    ),
    readRequiredTrimmedFile(
      join(agentDirectory, REGISTRY_AUTH_FILE_NAME),
      REGISTRY_AUTH_FILE_NAME,
      readFileImpl,
    ),
    readConnectorAssignedBaseUrl(configDir, agentName, readFileImpl),
    readRelayRuntimeConfig(configDir, readFileImpl),
    resolveConfigImpl(),
    loadConnectorModule(),
  ]);

  if (typeof connectorModule.startConnectorRuntime !== "function") {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_PACKAGE_API",
      "Connector package does not expose startConnectorRuntime",
    );
  }

  const identity = parseAgentIdentity(rawIdentity);
  const registryAuth = parseRegistryAuth(rawRegistryAuth);
  const resolvedProxyWebsocketUrl = await resolveProxyWebsocketUrl({
    explicitProxyWsUrl: commandOptions.proxyWsUrl,
    configProxyUrl: config.proxyUrl,
    registryUrl: config.registryUrl,
    fetchImpl,
  });
  const openclawHookToken =
    commandOptions.openclawHookToken ?? relayRuntimeConfig?.openclawHookToken;
  const outboundBaseUrl =
    resolveConnectorBaseUrlFromEnv() ??
    assignedConnectorBaseUrl ??
    DEFAULT_CONNECTOR_BASE_URL;
  const outboundPath = resolveConnectorOutboundPath();
  const runtime = await connectorModule.startConnectorRuntime({
    agentName,
    configDir,
    registryUrl: config.registryUrl,
    outboundBaseUrl,
    outboundPath,
    proxyWebsocketUrl: resolvedProxyWebsocketUrl,
    openclawBaseUrl: commandOptions.openclawBaseUrl,
    openclawHookPath: commandOptions.openclawHookPath,
    openclawHookToken,
    credentials: {
      agentDid: identity.did,
      ait: rawAit,
      secretKey: rawSecretKey,
      refreshToken: registryAuth.refreshToken,
      accessToken: registryAuth.accessToken,
      accessExpiresAt: registryAuth.accessExpiresAt,
      refreshExpiresAt: registryAuth.refreshExpiresAt,
      tokenType: registryAuth.tokenType,
    },
  });
  const outboundUrl =
    runtime && isRecord(runtime) && typeof runtime.outboundUrl === "string"
      ? runtime.outboundUrl
      : resolveOutboundUrl(outboundBaseUrl, outboundPath);
  const proxyWebsocketUrl =
    runtime && isRecord(runtime)
      ? typeof runtime.websocketUrl === "string"
        ? runtime.websocketUrl
        : typeof runtime.proxyWebsocketUrl === "string"
          ? runtime.proxyWebsocketUrl
          : resolvedProxyWebsocketUrl
      : undefined;

  return {
    outboundUrl,
    proxyWebsocketUrl,
    runtime,
  };
}

export function createConnectorCommand(
  dependencies: ConnectorCommandDependencies = {},
): Command {
  const connector = new Command("connector")
    .description("Run local connector runtime for OpenClaw relay handoff")
    .addCommand(
      new Command("start")
        .description("Start connector runtime for a local agent")
        .argument("<agentName>", "Local agent name")
        .option(
          "--proxy-ws-url <url>",
          "Proxy websocket URL (or CLAWDENTITY_PROXY_WS_URL)",
        )
        .option(
          "--openclaw-base-url <url>",
          "OpenClaw base URL (default OPENCLAW_BASE_URL or http://127.0.0.1:18789)",
        )
        .option(
          "--openclaw-hook-path <path>",
          "OpenClaw hooks path (default OPENCLAW_HOOK_PATH or /hooks/agent)",
        )
        .option(
          "--openclaw-hook-token <token>",
          "OpenClaw hooks token (default OPENCLAW_HOOK_TOKEN)",
        )
        .action(
          withErrorHandling(
            "connector start",
            async (
              agentNameInput: string,
              commandOptions: ConnectorStartCommandOptions,
            ) => {
              const agentName = assertValidAgentName(agentNameInput);

              writeStdoutLine(
                `Starting connector runtime for agent "${agentName}"...`,
              );

              const started = await startConnectorForAgent(
                agentName,
                {
                  proxyWsUrl: commandOptions.proxyWsUrl,
                  openclawBaseUrl: commandOptions.openclawBaseUrl,
                  openclawHookPath: commandOptions.openclawHookPath,
                  openclawHookToken: commandOptions.openclawHookToken,
                },
                dependencies,
              );

              writeStdoutLine(
                `Connector outbound endpoint: ${started.outboundUrl}`,
              );
              if (started.proxyWebsocketUrl) {
                writeStdoutLine(
                  `Connector proxy websocket: ${started.proxyWebsocketUrl}`,
                );
              }
              writeStdoutLine("Connector runtime is active.");

              const waitPromise = resolveWaitPromise(started.runtime);
              if (waitPromise) {
                await waitPromise;
              }
            },
          ),
        ),
    )
    .addCommand(
      new Command("service")
        .description("Install or remove connector autostart service")
        .addCommand(
          new Command("install")
            .description("Install and start connector service at login/restart")
            .argument("<agentName>", "Local agent name")
            .option(
              "--platform <platform>",
              "Service platform: auto | launchd | systemd",
            )
            .option(
              "--proxy-ws-url <url>",
              "Proxy websocket URL (or CLAWDENTITY_PROXY_WS_URL)",
            )
            .option(
              "--openclaw-base-url <url>",
              "OpenClaw base URL override for connector runtime",
            )
            .option(
              "--openclaw-hook-path <path>",
              "OpenClaw hooks path override for connector runtime",
            )
            .option(
              "--openclaw-hook-token <token>",
              "OpenClaw hooks token override for connector runtime",
            )
            .action(
              withErrorHandling(
                "connector service install",
                async (
                  agentNameInput: string,
                  commandOptions: ConnectorServiceInstallCommandOptions,
                ) => {
                  const agentName = assertValidAgentName(agentNameInput);
                  const installed = await installConnectorServiceForAgent(
                    agentName,
                    {
                      platform: commandOptions.platform,
                      proxyWsUrl: commandOptions.proxyWsUrl,
                      openclawBaseUrl: commandOptions.openclawBaseUrl,
                      openclawHookPath: commandOptions.openclawHookPath,
                      openclawHookToken: commandOptions.openclawHookToken,
                    },
                    dependencies,
                  );

                  writeStdoutLine(
                    `Connector service installed (${installed.platform}): ${installed.serviceName}`,
                  );
                  writeStdoutLine(`Service file: ${installed.serviceFilePath}`);
                },
              ),
            ),
        )
        .addCommand(
          new Command("uninstall")
            .description("Uninstall connector autostart service")
            .argument("<agentName>", "Local agent name")
            .option(
              "--platform <platform>",
              "Service platform: auto | launchd | systemd",
            )
            .action(
              withErrorHandling(
                "connector service uninstall",
                async (
                  agentNameInput: string,
                  commandOptions: ConnectorServiceUninstallCommandOptions,
                ) => {
                  const agentName = assertValidAgentName(agentNameInput);
                  const uninstalled = await uninstallConnectorServiceForAgent(
                    agentName,
                    {
                      platform: commandOptions.platform,
                    },
                    dependencies,
                  );

                  writeStdoutLine(
                    `Connector service uninstalled (${uninstalled.platform}): ${uninstalled.serviceName}`,
                  );
                  writeStdoutLine(
                    `Service file removed: ${uninstalled.serviceFilePath}`,
                  );
                },
              ),
            ),
        ),
    );

  logger.debug("cli.connector.command_registered", {
    command: "connector",
  });

  return connector;
}
