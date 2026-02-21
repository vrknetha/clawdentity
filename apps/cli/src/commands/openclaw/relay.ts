import { AppError, nowIso } from "@clawdentity/sdk";
import {
  createCliError,
  parsePeerAlias,
  resolveProbeMessage,
  resolveProbeSessionId,
} from "./common.js";
import {
  fetchConnectorHealthStatus,
  resolveConnectorAssignment,
  resolveSelectedAgentName,
} from "./connector.js";
import {
  DEFAULT_OPENCLAW_BASE_URL,
  OPENCLAW_PAIRING_COMMAND_HINT,
  OPENCLAW_SETUP_COMMAND_HINT,
} from "./constants.js";
import { runOpenclawDoctor } from "./doctor.js";
import { toSendToPeerEndpoint } from "./output.js";
import {
  resolveHomeDir,
  resolveOpenclawDir,
  resolvePeersPath,
  resolveRelayRuntimeConfigPath,
} from "./paths.js";
import {
  loadPeersConfig,
  resolveHookToken,
  resolveOpenclawBaseUrl,
} from "./state.js";
import type {
  OpenclawRelayTestOptions,
  OpenclawRelayTestResult,
  OpenclawRelayWebsocketTestOptions,
  OpenclawRelayWebsocketTestResult,
} from "./types.js";

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

export async function runOpenclawRelayWebsocketTest(
  options: OpenclawRelayWebsocketTestOptions,
): Promise<OpenclawRelayWebsocketTestResult> {
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
  if (preflight.status === "unhealthy") {
    const firstFailure = preflight.checks.find(
      (check) => check.status === "fail",
    );
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      message:
        firstFailure === undefined
          ? "Preflight checks failed"
          : `Preflight failed: ${firstFailure.label}`,
      remediationHint: firstFailure?.remediationHint,
      preflight,
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      message: "fetch implementation is unavailable",
      remediationHint:
        "Run relay websocket test in a Node runtime with fetch support",
      preflight,
    };
  }

  let connectorBaseUrl: string | undefined;
  let connectorStatusUrl: string | undefined;
  try {
    const selectedAgent = await resolveSelectedAgentName({ homeDir });
    const connectorAssignment = await resolveConnectorAssignment({
      homeDir,
      agentName: selectedAgent.agentName,
    });
    connectorBaseUrl = connectorAssignment.connectorBaseUrl;
    connectorStatusUrl = connectorAssignment.connectorStatusUrl;
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      connectorBaseUrl,
      connectorStatusUrl,
      message:
        appError?.message ??
        "Unable to resolve connector assignment for websocket test",
      remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      details: appError?.details as Record<string, unknown> | undefined,
      preflight,
    };
  }

  const connectorStatus = await fetchConnectorHealthStatus({
    connectorBaseUrl,
    fetchImpl,
  });
  if (!connectorStatus.connected) {
    return {
      status: "failure",
      checkedAt,
      peerAlias,
      connectorBaseUrl,
      connectorStatusUrl: connectorStatus.statusUrl,
      message: "Connector websocket is not connected",
      remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      details:
        connectorStatus.reason === undefined
          ? undefined
          : {
              reason: connectorStatus.reason,
            },
      preflight,
    };
  }

  return {
    status: "success",
    checkedAt,
    peerAlias,
    connectorBaseUrl,
    connectorStatusUrl: connectorStatus.statusUrl,
    message: "Connector websocket is connected for paired relay",
    preflight,
  };
}
