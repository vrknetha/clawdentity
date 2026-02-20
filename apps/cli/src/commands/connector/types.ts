import type { getConfigDir, resolveConfig } from "../../config/manager.js";

export const AGENTS_DIR_NAME = "agents";
export const IDENTITY_FILE_NAME = "identity.json";
export const AIT_FILE_NAME = "ait.jwt";
export const SECRET_KEY_FILE_NAME = "secret.key";
export const REGISTRY_AUTH_FILE_NAME = "registry-auth.json";
export const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
export const OPENCLAW_CONNECTORS_FILE_NAME = "openclaw-connectors.json";
export const SERVICE_LOG_DIR_NAME = "logs";

export const DEFAULT_CONNECTOR_BASE_URL = "http://127.0.0.1:19400";
export const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";

export type ConnectorCredentials = {
  accessToken?: string;
  accessExpiresAt?: string;
  agentDid: string;
  ait: string;
  refreshToken: string;
  refreshExpiresAt?: string;
  secretKey: string;
  tokenType?: "Bearer";
};

export type ConnectorStartInput = {
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

export type ConnectorRuntime = {
  closed?: Promise<void>;
  outboundUrl?: string;
  proxyWebsocketUrl?: string;
  waitForStop?: () => Promise<void>;
  waitUntilStopped?: () => Promise<void>;
  websocketUrl?: string;
};

export type ConnectorModule = {
  startConnectorRuntime?: (
    input: ConnectorStartInput,
  ) => Promise<ConnectorRuntime | undefined>;
};

export type ReadFileText = (path: string, encoding: "utf8") => Promise<string>;
export type ResolveConfigLike = () => Promise<{
  registryUrl: string;
  proxyUrl?: string;
}>;
export type ExecFileLike = (
  file: string,
  args?: readonly string[],
) => Promise<{ stderr: string; stdout: string }>;
export type MkdirLike = (
  path: string,
  options?: { recursive?: boolean },
) => Promise<void>;
export type WriteFileLike = (
  filePath: string,
  data: string,
  encoding: "utf8",
) => Promise<void>;
export type RemoveFileLike = (
  filePath: string,
  options?: { force?: boolean },
) => Promise<void>;
export type ResolveHomeDirLike = () => string;
export type ResolveNodeExecPathLike = () => string;
export type ResolveCurrentPlatformLike = () => NodeJS.Platform;
export type ResolveCurrentModulePathLike = () => string;
export type ResolveCurrentUidLike = () => number;

export type ConnectorCommandDependencies = {
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
  resolveConfigImpl?: typeof resolveConfig;
  resolveNodeExecPathImpl?: ResolveNodeExecPathLike;
  writeFileImpl?: WriteFileLike;
};

export type ConnectorStartCommandOptions = {
  openclawBaseUrl?: string;
  openclawHookPath?: string;
  openclawHookToken?: string;
  proxyWsUrl?: string;
};

export type ConnectorServicePlatform = "launchd" | "systemd";

export type ConnectorServiceInstallCommandOptions =
  ConnectorStartCommandOptions & {
    platform?: "auto" | ConnectorServicePlatform;
  };

export type ConnectorServiceUninstallCommandOptions = {
  platform?: "auto" | ConnectorServicePlatform;
};

export type ConnectorStartResult = {
  outboundUrl: string;
  proxyWebsocketUrl?: string;
  runtime?: ConnectorRuntime | undefined;
};

export type OpenclawRelayRuntimeConfig = {
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
