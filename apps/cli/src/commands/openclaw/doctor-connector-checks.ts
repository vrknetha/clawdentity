import { toDoctorCheck } from "./common.js";
import { fetchConnectorHealthStatus } from "./connector.js";
import {
  OPENCLAW_SETUP_COMMAND_HINT,
  OPENCLAW_SETUP_RESTART_COMMAND_HINT,
} from "./constants.js";
import { resolveConnectorAssignmentsPath } from "./paths.js";
import { loadConnectorAssignments } from "./state.js";
import type { OpenclawDoctorCheckResult } from "./types.js";

export async function runDoctorConnectorRuntimeChecks(input: {
  homeDir: string;
  selectedAgentName?: string;
  fetchImpl?: typeof fetch;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  if (input.selectedAgentName === undefined) {
    input.checks.push(
      toDoctorCheck({
        id: "state.connectorRuntime",
        label: "Connector runtime",
        status: "fail",
        message:
          "cannot validate connector runtime without selected agent marker",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
    input.checks.push(
      toDoctorCheck({
        id: "state.connectorInboundInbox",
        label: "Connector inbound inbox",
        status: "fail",
        message:
          "cannot validate connector inbound inbox without selected agent marker",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
    input.checks.push(
      toDoctorCheck({
        id: "state.openclawHookHealth",
        label: "OpenClaw hook health",
        status: "fail",
        message:
          "cannot validate OpenClaw hook health without selected agent marker",
        remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
      }),
    );
    return;
  }

  const connectorAssignmentsPath = resolveConnectorAssignmentsPath(
    input.homeDir,
  );
  try {
    const connectorAssignments = await loadConnectorAssignments(
      connectorAssignmentsPath,
    );
    const assignment = connectorAssignments.agents[input.selectedAgentName];
    if (assignment === undefined) {
      input.checks.push(
        toDoctorCheck({
          id: "state.connectorRuntime",
          label: "Connector runtime",
          status: "fail",
          message: `no connector assignment found for ${input.selectedAgentName}`,
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
          details: {
            connectorAssignmentsPath,
            selectedAgentName: input.selectedAgentName,
          },
        }),
      );
      input.checks.push(
        toDoctorCheck({
          id: "state.connectorInboundInbox",
          label: "Connector inbound inbox",
          status: "fail",
          message: `no connector assignment found for ${input.selectedAgentName}`,
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
          details: {
            connectorAssignmentsPath,
            selectedAgentName: input.selectedAgentName,
          },
        }),
      );
      input.checks.push(
        toDoctorCheck({
          id: "state.openclawHookHealth",
          label: "OpenClaw hook health",
          status: "fail",
          message: `no connector assignment found for ${input.selectedAgentName}`,
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
          details: {
            connectorAssignmentsPath,
            selectedAgentName: input.selectedAgentName,
          },
        }),
      );
      return;
    }

    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      input.checks.push(
        toDoctorCheck({
          id: "state.connectorRuntime",
          label: "Connector runtime",
          status: "fail",
          message: "fetch implementation is unavailable for connector checks",
          remediationHint:
            "Run doctor in a Node runtime with fetch support, or rerun openclaw setup",
        }),
      );
      input.checks.push(
        toDoctorCheck({
          id: "state.connectorInboundInbox",
          label: "Connector inbound inbox",
          status: "fail",
          message:
            "fetch implementation is unavailable for connector inbox checks",
          remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
        }),
      );
      input.checks.push(
        toDoctorCheck({
          id: "state.openclawHookHealth",
          label: "OpenClaw hook health",
          status: "fail",
          message:
            "fetch implementation is unavailable for OpenClaw hook health checks",
          remediationHint: OPENCLAW_SETUP_RESTART_COMMAND_HINT,
        }),
      );
      return;
    }

    const connectorStatus = await fetchConnectorHealthStatus({
      connectorBaseUrl: assignment.connectorBaseUrl,
      fetchImpl,
    });
    if (connectorStatus.connected) {
      input.checks.push(
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
      const inboxPendingCount = connectorStatus.inboundInbox?.pendingCount ?? 0;
      const replayError = connectorStatus.inboundInbox?.lastReplayError;
      input.checks.push(
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
      input.checks.push(
        toDoctorCheck({
          id: "state.openclawHookHealth",
          label: "OpenClaw hook health",
          status:
            connectorStatus.openclawHook?.lastAttemptStatus === "failed" &&
            inboxPendingCount > 0
              ? "fail"
              : "pass",
          message:
            connectorStatus.openclawHook?.lastAttemptStatus === "failed" &&
            inboxPendingCount > 0
              ? `connector replay to local OpenClaw hook is failing: ${replayError ?? "unknown error"}`
              : "connector replay to local OpenClaw hook is healthy",
          remediationHint:
            connectorStatus.openclawHook?.lastAttemptStatus === "failed" &&
            inboxPendingCount > 0
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
      return;
    }

    const reason = connectorStatus.reason ?? "connector runtime is unavailable";
    input.checks.push(
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
    input.checks.push(
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
    input.checks.push(
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
  } catch {
    input.checks.push(
      toDoctorCheck({
        id: "state.connectorRuntime",
        label: "Connector runtime",
        status: "fail",
        message: `unable to read connector assignments at ${connectorAssignmentsPath}`,
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
        details: { connectorAssignmentsPath },
      }),
    );
    input.checks.push(
      toDoctorCheck({
        id: "state.connectorInboundInbox",
        label: "Connector inbound inbox",
        status: "fail",
        message:
          "cannot validate connector inbound inbox without connector assignment",
        remediationHint: OPENCLAW_SETUP_COMMAND_HINT,
      }),
    );
    input.checks.push(
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
