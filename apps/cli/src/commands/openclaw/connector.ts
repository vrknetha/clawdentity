import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonResponseSafe } from "@clawdentity/common";
import { nowUtcMs } from "@clawdentity/sdk";
import { getConfigDir } from "../../config/manager.js";
import { assertValidAgentName } from "../agent-name.js";
import { installConnectorServiceForAgent } from "../connector.js";
import { createCliError, getErrorCode, isRecord } from "./common.js";
import {
  CONNECTOR_DETACHED_STDERR_FILE_SUFFIX,
  CONNECTOR_DETACHED_STDOUT_FILE_SUFFIX,
  CONNECTOR_HOST_DOCKER,
  CONNECTOR_HOST_DOCKER_GATEWAY,
  CONNECTOR_HOST_LINUX_BRIDGE,
  CONNECTOR_HOST_LOOPBACK,
  CONNECTOR_RUN_DIR_NAME,
  DEFAULT_CONNECTOR_PORT,
  DEFAULT_CONNECTOR_STATUS_PATH,
  DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS,
  logger,
} from "./constants.js";
import {
  resolveConnectorAssignmentsPath,
  resolveOpenclawAgentNamePath,
} from "./paths.js";
import { loadConnectorAssignments, writeSecureFile } from "./state.js";
import type {
  ConnectorAssignmentsConfig,
  ConnectorHealthStatus,
  OpenclawRuntimeMode,
  OpenclawRuntimeResult,
  ParsedConnectorStatusPayload,
} from "./types.js";

export function parseConnectorPortFromBaseUrl(baseUrl: string): number {
  const parsed = new URL(baseUrl);
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

export function allocateConnectorPort(
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

export function buildConnectorBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function buildRelayConnectorBaseUrls(port: number): string[] {
  return [
    buildConnectorBaseUrl(CONNECTOR_HOST_DOCKER, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_DOCKER_GATEWAY, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_LINUX_BRIDGE, port),
    buildConnectorBaseUrl(CONNECTOR_HOST_LOOPBACK, port),
  ];
}

export function parseOpenclawRuntimeMode(value: unknown): OpenclawRuntimeMode {
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

export function parseWaitTimeoutSeconds(value: unknown): number {
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

export function resolveConnectorStatusUrl(connectorBaseUrl: string): string {
  const normalizedBase = connectorBaseUrl.endsWith("/")
    ? connectorBaseUrl
    : `${connectorBaseUrl}/`;
  return new URL(
    DEFAULT_CONNECTOR_STATUS_PATH.slice(1),
    normalizedBase,
  ).toString();
}

function parseConnectorStatusPayload(
  payload: unknown,
): ParsedConnectorStatusPayload {
  if (
    !isRecord(payload) ||
    !isRecord(payload.websocket) ||
    typeof payload.websocket.connected !== "boolean"
  ) {
    throw createCliError(
      "CLI_OPENCLAW_SETUP_CONNECTOR_STATUS_INVALID",
      "Connector status response is invalid",
    );
  }

  const inboundRoot = isRecord(payload.inbound) ? payload.inbound : undefined;
  const pending =
    inboundRoot && isRecord(inboundRoot.pending)
      ? inboundRoot.pending
      : undefined;
  const deadLetter =
    inboundRoot && isRecord(inboundRoot.deadLetter)
      ? inboundRoot.deadLetter
      : undefined;
  const replay =
    inboundRoot && isRecord(inboundRoot.replay)
      ? inboundRoot.replay
      : undefined;
  const hook =
    inboundRoot && isRecord(inboundRoot.openclawHook)
      ? inboundRoot.openclawHook
      : undefined;

  return {
    websocketConnected: payload.websocket.connected,
    inboundInbox:
      pending || deadLetter || replay
        ? {
            pendingCount:
              pending && typeof pending.pendingCount === "number"
                ? pending.pendingCount
                : undefined,
            pendingBytes:
              pending && typeof pending.pendingBytes === "number"
                ? pending.pendingBytes
                : undefined,
            oldestPendingAt:
              pending && typeof pending.oldestPendingAt === "string"
                ? pending.oldestPendingAt
                : undefined,
            nextAttemptAt:
              pending && typeof pending.nextAttemptAt === "string"
                ? pending.nextAttemptAt
                : undefined,
            lastReplayAt:
              replay && typeof replay.lastReplayAt === "string"
                ? replay.lastReplayAt
                : undefined,
            lastReplayError:
              replay && typeof replay.lastReplayError === "string"
                ? replay.lastReplayError
                : undefined,
            replayerActive:
              replay && typeof replay.replayerActive === "boolean"
                ? replay.replayerActive
                : undefined,
            deadLetterCount:
              deadLetter && typeof deadLetter.deadLetterCount === "number"
                ? deadLetter.deadLetterCount
                : undefined,
            deadLetterBytes:
              deadLetter && typeof deadLetter.deadLetterBytes === "number"
                ? deadLetter.deadLetterBytes
                : undefined,
            oldestDeadLetterAt:
              deadLetter && typeof deadLetter.oldestDeadLetterAt === "string"
                ? deadLetter.oldestDeadLetterAt
                : undefined,
          }
        : undefined,
    openclawHook: hook
      ? {
          url: typeof hook.url === "string" ? hook.url : undefined,
          lastAttemptAt:
            typeof hook.lastAttemptAt === "string"
              ? hook.lastAttemptAt
              : undefined,
          lastAttemptStatus:
            hook.lastAttemptStatus === "ok" ||
            hook.lastAttemptStatus === "failed"
              ? hook.lastAttemptStatus
              : undefined,
        }
      : undefined,
  };
}

export async function fetchConnectorHealthStatus(input: {
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

    const payload = await parseJsonResponseSafe(response);
    if (payload === undefined) {
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

export async function waitForConnectorConnected(input: {
  connectorBaseUrl: string;
  fetchImpl: typeof fetch;
  waitTimeoutSeconds: number;
}): Promise<ConnectorHealthStatus> {
  const deadline = nowUtcMs() + input.waitTimeoutSeconds * 1000;
  let latest = await fetchConnectorHealthStatus({
    connectorBaseUrl: input.connectorBaseUrl,
    fetchImpl: input.fetchImpl,
  });

  while (!latest.connected && nowUtcMs() < deadline) {
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

export async function monitorConnectorStabilityWindow(input: {
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

  const deadline = nowUtcMs() + input.durationSeconds * 1000;
  let latest = await fetchConnectorHealthStatus({
    connectorBaseUrl: input.connectorBaseUrl,
    fetchImpl: input.fetchImpl,
  });
  if (!latest.connected) {
    return latest;
  }

  while (nowUtcMs() < deadline) {
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

export function resolveConnectorRunDir(homeDir: string): string {
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

export async function startSetupConnectorRuntime(input: {
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

export async function resolveSelectedAgentName(input: {
  homeDir: string;
}): Promise<{ agentName: string; selectedAgentPath: string }> {
  const selectedAgentPath = resolveOpenclawAgentNamePath(input.homeDir);
  let selectedAgentRaw: string;
  try {
    selectedAgentRaw = await readFile(selectedAgentPath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw createCliError(
        "CLI_OPENCLAW_SELECTED_AGENT_MISSING",
        "Selected agent marker is missing",
        { selectedAgentPath },
      );
    }
    throw createCliError(
      "CLI_OPENCLAW_SELECTED_AGENT_INVALID",
      "Selected agent marker is invalid",
      { selectedAgentPath },
    );
  }

  try {
    return {
      agentName: assertValidAgentName(selectedAgentRaw.trim()),
      selectedAgentPath,
    };
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_SELECTED_AGENT_INVALID",
      "Selected agent marker is invalid",
      { selectedAgentPath },
    );
  }
}

export async function resolveConnectorAssignment(input: {
  homeDir: string;
  agentName: string;
}): Promise<{
  connectorAssignmentsPath: string;
  connectorBaseUrl: string;
  connectorStatusUrl: string;
}> {
  const connectorAssignmentsPath = resolveConnectorAssignmentsPath(
    input.homeDir,
  );
  const connectorAssignments = await loadConnectorAssignments(
    connectorAssignmentsPath,
  );
  const assignment = connectorAssignments.agents[input.agentName];
  if (assignment === undefined) {
    throw createCliError(
      "CLI_OPENCLAW_CONNECTOR_ASSIGNMENT_MISSING",
      "Connector assignment is missing for selected agent",
      {
        connectorAssignmentsPath,
        agentName: input.agentName,
      },
    );
  }

  return {
    connectorAssignmentsPath,
    connectorBaseUrl: assignment.connectorBaseUrl,
    connectorStatusUrl: resolveConnectorStatusUrl(assignment.connectorBaseUrl),
  };
}
