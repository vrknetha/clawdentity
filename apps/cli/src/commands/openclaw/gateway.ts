import { spawn } from "node:child_process";
import { join } from "node:path";
import { getErrorCode, isRecord } from "./common.js";
import {
  OPENCLAW_GATEWAY_APPROVAL_COMMAND,
  OPENCLAW_GATEWAY_APPROVAL_TIMEOUT_MS,
} from "./constants.js";
import { resolveOpenclawConfigPath } from "./paths.js";
import { readJsonFile } from "./state.js";
import type {
  OpenclawGatewayDeviceApprovalAttempt,
  OpenclawGatewayDeviceApprovalExecution,
  OpenclawGatewayDeviceApprovalInput,
  OpenclawGatewayDeviceApprovalRunner,
  OpenclawGatewayDeviceApprovalSummary,
  OpenclawGatewayPendingState,
} from "./types.js";

export async function readOpenclawGatewayPendingState(
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

export function resolveOpenclawGatewayApprovalCommand(): string {
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

export async function autoApproveOpenclawGatewayDevices(input: {
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
