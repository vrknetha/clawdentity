import { parseDoctorPeerAlias, toDoctorResult } from "./common.js";
import { runDoctorConnectorRuntimeChecks } from "./doctor-connector-checks.js";
import {
  runDoctorConfigCheck,
  runDoctorCredentialsCheck,
  runDoctorGatewayPairingCheck,
  runDoctorOpenclawBaseUrlCheck,
  runDoctorOpenclawConfigCheck,
  runDoctorPeersCheck,
  runDoctorSelectedAgentCheck,
  runDoctorTransformCheck,
} from "./doctor-static-checks.js";
import { resolveHomeDir, resolveOpenclawDir } from "./paths.js";
import type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorOptions,
  OpenclawDoctorResult,
} from "./types.js";

export async function runOpenclawDoctor(
  options: OpenclawDoctorOptions = {},
): Promise<OpenclawDoctorResult> {
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(options.openclawDir, homeDir);
  const peerAlias = parseDoctorPeerAlias(options.peerAlias);
  const checks: OpenclawDoctorCheckResult[] = [];

  await runDoctorConfigCheck({ options, checks });

  const selectedAgentName = await runDoctorSelectedAgentCheck({
    homeDir,
    checks,
  });
  await runDoctorCredentialsCheck({ homeDir, selectedAgentName, checks });

  await runDoctorPeersCheck({ homeDir, peerAlias, checks });
  await runDoctorTransformCheck({ openclawDir, checks });
  await runDoctorOpenclawConfigCheck({ openclawDir, homeDir, checks });
  await runDoctorOpenclawBaseUrlCheck({ homeDir, checks });
  await runDoctorGatewayPairingCheck({ openclawDir, checks });

  if (options.includeConnectorRuntimeCheck !== false) {
    await runDoctorConnectorRuntimeChecks({
      homeDir,
      selectedAgentName,
      fetchImpl: options.fetchImpl,
      checks,
    });
  }

  return toDoctorResult(checks);
}
