import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { nowIso } from "@clawdentity/sdk";
import { assertValidAgentName } from "../agent-name.js";
import {
  createCliError,
  decodeInvitePayload,
  encodeInvitePayload,
  getErrorCode,
  parseAgentDid,
  parseInvitePayload,
  parseOptionalProfileName,
  parsePeerAlias,
  parseProxyUrl,
} from "./common.js";
import { patchOpenclawConfig } from "./config.js";
import {
  allocateConnectorPort,
  buildConnectorBaseUrl,
  buildRelayConnectorBaseUrls,
  monitorConnectorStabilityWindow,
  parseOpenclawRuntimeMode,
  parseWaitTimeoutSeconds,
  startSetupConnectorRuntime,
} from "./connector.js";
import {
  CONNECTOR_HOST_LOOPBACK,
  DEFAULT_CONNECTOR_OUTBOUND_PATH,
  logger,
  OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT,
  OPENCLAW_SETUP_STABILITY_POLL_INTERVAL_MS,
  OPENCLAW_SETUP_STABILITY_WINDOW_SECONDS,
  RELAY_PEERS_FILE_NAME,
} from "./constants.js";
import { runOpenclawDoctor } from "./doctor.js";
import {
  autoApproveOpenclawGatewayDevices,
  resolveOpenclawGatewayApprovalCommand,
} from "./gateway.js";
import {
  resolveConnectorAssignmentsPath,
  resolveDefaultTransformSource,
  resolveHomeDir,
  resolveOpenclawAgentNamePath,
  resolveOpenclawConfigPath,
  resolveOpenclawDir,
  resolvePeersPath,
  resolveRelayRuntimeConfigPath,
  resolveTransformPeersPath,
  resolveTransformRuntimePath,
  resolveTransformTargetPath,
} from "./paths.js";
import {
  ensureLocalAgentCredentials,
  loadConnectorAssignments,
  loadPeersConfig,
  loadRelayRuntimeConfig,
  resolveOpenclawBaseUrl,
  saveConnectorAssignments,
  savePeersConfig,
  saveRelayRuntimeConfig,
  writeSecureFile,
} from "./state.js";
import type {
  OpenclawGatewayDeviceApprovalSummary,
  OpenclawInviteOptions,
  OpenclawInvitePayload,
  OpenclawInviteResult,
  OpenclawSelfSetupResult,
  OpenclawSetupOptions,
  OpenclawSetupResult,
} from "./types.js";

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
  gatewayDeviceApprovalRunner?: OpenclawSetupOptions["gatewayDeviceApprovalRunner"];
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
