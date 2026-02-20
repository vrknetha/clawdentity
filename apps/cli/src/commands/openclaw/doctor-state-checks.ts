import { readFile } from "node:fs/promises";
import { AppError } from "@clawdentity/sdk";
import { assertValidAgentName } from "../agent-name.js";
import { getErrorCode, toDoctorCheck } from "./common.js";
import {
  OPENCLAW_PAIRING_COMMAND_HINT,
  OPENCLAW_SETUP_COMMAND_HINT,
} from "./constants.js";
import {
  resolveOpenclawAgentNamePath,
  resolvePeersPath,
  resolveTransformPeersPath,
  resolveTransformRuntimePath,
  resolveTransformTargetPath,
} from "./paths.js";
import { ensureLocalAgentCredentials, loadPeersConfig } from "./state.js";
import type { OpenclawDoctorCheckResult, PeersConfig } from "./types.js";

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
