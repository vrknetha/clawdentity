import { readFile } from "node:fs/promises";
import { AppError } from "@clawdentity/sdk";
import { resolveConfig } from "../../config/manager.js";
import { assertValidAgentName } from "../agent-name.js";
import {
  getErrorCode,
  isRecord,
  normalizeStringArrayWithValues,
  parseProxyUrl,
  toDoctorCheck,
} from "./common.js";
import {
  hasRelayTransformModule,
  isCanonicalAgentSessionKey,
  isRelayHookMapping,
  parseGatewayAuthMode,
} from "./config.js";
import {
  OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT,
  OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT,
  OPENCLAW_PAIRING_COMMAND_HINT,
  OPENCLAW_SETUP_COMMAND_HINT,
  OPENCLAW_SETUP_RESTART_COMMAND_HINT,
  OPENCLAW_SETUP_WITH_BASE_URL_HINT,
} from "./constants.js";
import { readOpenclawGatewayPendingState } from "./gateway.js";
import {
  resolveOpenclawAgentNamePath,
  resolveOpenclawConfigPath,
  resolvePeersPath,
  resolveRelayRuntimeConfigPath,
  resolveTransformPeersPath,
  resolveTransformRuntimePath,
  resolveTransformTargetPath,
} from "./paths.js";
import {
  ensureLocalAgentCredentials,
  loadPeersConfig,
  readJsonFile,
  resolveOpenclawBaseUrl,
} from "./state.js";
import type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorOptions,
  PeersConfig,
} from "./types.js";

export async function runDoctorConfigCheck(input: {
  options: OpenclawDoctorOptions;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  if (input.options.includeConfigCheck === false) {
    return;
  }

  const resolveConfigImpl = input.options.resolveConfigImpl ?? resolveConfig;
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
      input.checks.push(
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
      input.checks.push(
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
        input.checks.push(
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
        input.checks.push(
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
      input.checks.push(
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
        input.checks.push(
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
        input.checks.push(
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
    input.checks.push(
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

export async function runDoctorSelectedAgentCheck(input: {
  homeDir: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<string | undefined> {
  const selectedAgentPath = resolveOpenclawAgentNamePath(input.homeDir);
  let selectedAgentName: string | undefined;
  try {
    const selectedAgentRaw = await readFile(selectedAgentPath, "utf8");
    selectedAgentName = assertValidAgentName(selectedAgentRaw.trim());
    input.checks.push(
      toDoctorCheck({
        id: "state.selectedAgent",
        label: "Selected agent marker",
        status: "pass",
        message: `selected agent is ${selectedAgentName}`,
      }),
    );
  } catch (error) {
    const missing = getErrorCode(error) === "ENOENT";
    input.checks.push(
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

  return selectedAgentName;
}

export async function runDoctorCredentialsCheck(input: {
  homeDir: string;
  selectedAgentName?: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  if (input.selectedAgentName === undefined) {
    input.checks.push(
      toDoctorCheck({
        id: "state.credentials",
        label: "Local agent credentials",
        status: "fail",
        message: "cannot validate credentials without selected agent marker",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
    return;
  }

  try {
    await ensureLocalAgentCredentials(input.homeDir, input.selectedAgentName);
    input.checks.push(
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
    input.checks.push(
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
            : { filePath, selectedAgentName: input.selectedAgentName },
      }),
    );
  }
}

export async function runDoctorPeersCheck(input: {
  homeDir: string;
  peerAlias?: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<PeersConfig | undefined> {
  const peersPath = resolvePeersPath(input.homeDir);
  let peersConfig: PeersConfig | undefined;
  try {
    peersConfig = await loadPeersConfig(peersPath);
    const peerAliases = Object.keys(peersConfig.peers);
    if (input.peerAlias !== undefined) {
      if (peersConfig.peers[input.peerAlias] === undefined) {
        input.checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "fail",
            message: `peer alias is missing: ${input.peerAlias}`,
            remediationHint: OPENCLAW_PAIRING_COMMAND_HINT,
            details: { peersPath, peerAlias: input.peerAlias },
          }),
        );
      } else {
        input.checks.push(
          toDoctorCheck({
            id: "state.peers",
            label: "Peers map",
            status: "pass",
            message: `peer alias exists: ${input.peerAlias}`,
            details: { peersPath, peerAlias: input.peerAlias },
          }),
        );
      }
    } else if (peerAliases.length === 0) {
      input.checks.push(
        toDoctorCheck({
          id: "state.peers",
          label: "Peers map",
          status: "pass",
          message: "no peers are configured yet (optional until pairing)",
          details: { peersPath },
        }),
      );
    } else {
      input.checks.push(
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
    input.checks.push(
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

  return peersConfig;
}

export async function runDoctorTransformCheck(input: {
  openclawDir: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  const transformTargetPath = resolveTransformTargetPath(input.openclawDir);
  const relayTransformRuntimePath = resolveTransformRuntimePath(
    input.openclawDir,
  );
  const relayTransformPeersPath = resolveTransformPeersPath(input.openclawDir);
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
      input.checks.push(
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
      input.checks.push(
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
    input.checks.push(
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
}

export async function runDoctorOpenclawConfigCheck(input: {
  openclawDir: string;
  homeDir: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  const openclawConfigPath = resolveOpenclawConfigPath(
    input.openclawDir,
    input.homeDir,
  );
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
      input.checks.push(
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
      input.checks.push(
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
      input.checks.push(
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
      input.checks.push(
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
      input.checks.push(
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
      input.checks.push(
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
      input.checks.push(
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
        input.checks.push(
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
        input.checks.push(
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
        input.checks.push(
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
        input.checks.push(
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
      input.checks.push(
        toDoctorCheck({
          id: "state.gatewayAuth",
          label: "OpenClaw gateway auth",
          status: "pass",
          message: "gateway auth is configured with trusted-proxy mode",
          details: { openclawConfigPath, gatewayAuthMode },
        }),
      );
    } else {
      input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
}

export async function runDoctorOpenclawBaseUrlCheck(input: {
  homeDir: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  const relayRuntimeConfigPath = resolveRelayRuntimeConfigPath(input.homeDir);
  try {
    const openclawBaseUrl = await resolveOpenclawBaseUrl({
      relayRuntimeConfigPath,
    });
    input.checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "pass",
        message: `resolved to ${openclawBaseUrl}`,
      }),
    );
  } catch {
    input.checks.push(
      toDoctorCheck({
        id: "state.openclawBaseUrl",
        label: "OpenClaw base URL",
        status: "fail",
        message: `unable to resolve OpenClaw base URL from ${relayRuntimeConfigPath}`,
        remediationHint: OPENCLAW_SETUP_WITH_BASE_URL_HINT,
      }),
    );
  }
}

export async function runDoctorGatewayPairingCheck(input: {
  openclawDir: string;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  const gatewayPendingState = await readOpenclawGatewayPendingState(
    input.openclawDir,
  );
  if (gatewayPendingState.status === "missing") {
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
}
