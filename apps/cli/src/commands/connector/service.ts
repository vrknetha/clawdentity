import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getConfigDir, resolveConfig } from "../../config/manager.js";
import {
  readConnectorAssignedBaseUrl,
  readRelayRuntimeConfig,
  resolveConnectorBaseUrlFromEnv,
  resolveConnectorOutboundPath,
  resolveOutboundUrl,
  resolveProxyWebsocketUrl,
} from "./config.js";
import {
  parseAgentIdentity,
  parseRegistryAuth,
  readRequiredTrimmedFile,
} from "./credentials.js";
import {
  loadDefaultConnectorModule,
  resolveRuntimeOutboundUrl,
  resolveRuntimeProxyWebsocketUrl,
} from "./runtime.js";
import {
  AGENTS_DIR_NAME,
  AIT_FILE_NAME,
  type ConnectorCommandDependencies,
  type ConnectorServiceInstallCommandOptions,
  type ConnectorServiceInstallResult,
  type ConnectorServiceUninstallCommandOptions,
  type ConnectorServiceUninstallResult,
  type ConnectorStartCommandOptions,
  type ConnectorStartResult,
  DEFAULT_CONNECTOR_BASE_URL,
  type ExecFileLike,
  IDENTITY_FILE_NAME,
  REGISTRY_AUTH_FILE_NAME,
  type ReadFileText,
  type ResolveConfigLike,
  type ResolveCurrentModulePathLike,
  SECRET_KEY_FILE_NAME,
  SERVICE_LOG_DIR_NAME,
} from "./types.js";
import {
  createCliError,
  parseConnectorServicePlatformOption,
  resolveConnectorServicePlatform,
  sanitizeServiceSegment,
} from "./validation.js";

const execFile = promisify(execFileCallback);

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
  const moduleDirectory = dirname(modulePath);

  if (basename(moduleDirectory) === "connector") {
    return join(moduleDirectory, "..", "..", "bin.js");
  }

  return join(moduleDirectory, "..", "bin.js");
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
  const outboundUrl = resolveRuntimeOutboundUrl(
    runtime,
    resolveOutboundUrl(outboundBaseUrl, outboundPath),
  );
  const proxyWebsocketUrl = resolveRuntimeProxyWebsocketUrl(
    runtime,
    resolvedProxyWebsocketUrl,
  );

  return {
    outboundUrl,
    proxyWebsocketUrl,
    runtime,
  };
}
