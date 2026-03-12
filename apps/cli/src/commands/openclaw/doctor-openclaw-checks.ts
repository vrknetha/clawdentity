import {
  isRecord,
  normalizeStringArrayWithValues,
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
  OPENCLAW_SETUP_COMMAND_HINT,
  OPENCLAW_SETUP_RESTART_COMMAND_HINT,
  OPENCLAW_SETUP_WITH_BASE_URL_HINT,
} from "./constants.js";
import { readOpenclawGatewayPendingState } from "./gateway.js";
import {
  resolveOpenclawConfigPath,
  resolveRelayRuntimeConfigPath,
} from "./paths.js";
import { readJsonFile, resolveOpenclawBaseUrl } from "./state.js";
import type { OpenclawDoctorCheckResult } from "./types.js";

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
