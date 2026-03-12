import { Command } from "commander";
import { writeStdoutLine } from "../../io.js";
import { withErrorHandling } from "../helpers.js";
import { runOpenclawDoctor } from "./doctor.js";
import {
  formatDoctorCheckLine,
  printDoctorResult,
  printRelayTestResult,
  printRelayWebsocketTestResult,
} from "./output.js";
import {
  runOpenclawRelayTest,
  runOpenclawRelayWebsocketTest,
} from "./relay.js";
import { setupOpenclawSelfReady } from "./setup.js";
import type {
  OpenclawDoctorCommandOptions,
  OpenclawRelayTestOptions,
  OpenclawRelayWebsocketTestOptions,
  OpenclawSetupCommandOptions,
} from "./types.js";

export const createOpenclawCommand = (): Command => {
  const openclawCommand = new Command("openclaw").description(
    "Manage OpenClaw relay setup",
  );

  openclawCommand
    .command("setup <agentName>")
    .description("Apply OpenClaw relay setup")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option(
      "--transform-source <path>",
      "Path to relay-to-peer.mjs (default <openclaw-dir>/skills/clawdentity-openclaw-relay/relay-to-peer.mjs)",
    )
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default http://127.0.0.1:18789)",
    )
    .option(
      "--runtime-mode <mode>",
      "Connector runtime mode: auto | service | detached (default auto)",
    )
    .option(
      "--wait-timeout-seconds <seconds>",
      "Seconds to wait for connector websocket readiness (default 30)",
    )
    .option(
      "--no-runtime-start",
      "Skip connector runtime startup (advanced/manual mode)",
    )
    .action(
      withErrorHandling(
        "openclaw setup",
        async (agentName: string, options: OpenclawSetupCommandOptions) => {
          const result = await setupOpenclawSelfReady(agentName, options);
          writeStdoutLine("Self setup complete");
          writeStdoutLine(
            `Updated OpenClaw config: ${result.openclawConfigPath}`,
          );
          writeStdoutLine(`Installed transform: ${result.transformTargetPath}`);
          writeStdoutLine(
            `Transform runtime config: ${result.relayTransformRuntimePath}`,
          );
          writeStdoutLine(
            `Transform peers snapshot: ${result.relayTransformPeersPath}`,
          );
          writeStdoutLine(`Connector base URL: ${result.connectorBaseUrl}`);
          writeStdoutLine(`OpenClaw base URL: ${result.openclawBaseUrl}`);
          writeStdoutLine(
            `Relay runtime config: ${result.relayRuntimeConfigPath}`,
          );
          writeStdoutLine(`Runtime mode: ${result.runtimeMode}`);
          writeStdoutLine(`Runtime status: ${result.runtimeStatus}`);
          writeStdoutLine(`WebSocket status: ${result.websocketStatus}`);
          if (result.connectorStatusUrl) {
            writeStdoutLine(
              `Connector status URL: ${result.connectorStatusUrl}`,
            );
          }
        },
      ),
    );

  openclawCommand
    .command("doctor")
    .description("Validate local OpenClaw relay setup and print remediation")
    .option("--peer <alias>", "Validate that a specific peer alias exists")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw doctor",
        async (options: OpenclawDoctorCommandOptions) => {
          const result = await runOpenclawDoctor({
            openclawDir: options.openclawDir,
            peerAlias: options.peer,
            json: options.json,
          });
          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printDoctorResult(result);
          }

          if (result.status === "unhealthy") {
            process.exitCode = 1;
          }
        },
      ),
    );

  const relayCommand = openclawCommand
    .command("relay")
    .description("Run OpenClaw relay diagnostics");

  relayCommand
    .command("test")
    .description(
      "Send a relay probe to a configured peer (auto-selects when one peer exists)",
    )
    .option("--peer <alias>", "Peer alias in local peers map")
    .option(
      "--openclaw-base-url <url>",
      "Base URL for local OpenClaw hook API (default OPENCLAW_BASE_URL or relay runtime config)",
    )
    .option(
      "--hook-token <token>",
      "OpenClaw hook token (default OPENCLAW_HOOK_TOKEN)",
    )
    .option("--session-id <id>", "Session id for the probe payload")
    .option("--message <text>", "Probe message body")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw relay test",
        async (options: OpenclawRelayTestOptions) => {
          const result = await runOpenclawRelayTest(options);

          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printRelayTestResult(result);
            if (
              result.preflight !== undefined &&
              result.preflight.status === "unhealthy"
            ) {
              writeStdoutLine("Preflight details:");
              for (const check of result.preflight.checks) {
                if (check.status === "fail") {
                  writeStdoutLine(formatDoctorCheckLine(check));
                  if (check.remediationHint) {
                    writeStdoutLine(`Fix: ${check.remediationHint}`);
                  }
                }
              }
            }
          }

          if (result.status === "failure") {
            process.exitCode = 1;
          }
        },
      ),
    );

  relayCommand
    .command("ws-test")
    .description(
      "Validate connector websocket connectivity for a paired relay peer",
    )
    .option("--peer <alias>", "Peer alias in local peers map")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory (default ~/.openclaw)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "openclaw relay ws-test",
        async (options: OpenclawRelayWebsocketTestOptions) => {
          const result = await runOpenclawRelayWebsocketTest(options);
          if (options.json) {
            writeStdoutLine(JSON.stringify(result, null, 2));
          } else {
            printRelayWebsocketTestResult(result);
            if (
              result.preflight !== undefined &&
              result.preflight.status === "unhealthy"
            ) {
              writeStdoutLine("Preflight details:");
              for (const check of result.preflight.checks) {
                if (check.status === "fail") {
                  writeStdoutLine(formatDoctorCheckLine(check));
                  if (check.remediationHint) {
                    writeStdoutLine(`Fix: ${check.remediationHint}`);
                  }
                }
              }
            }
          }

          if (result.status === "failure") {
            process.exitCode = 1;
          }
        },
      ),
    );

  return openclawCommand;
};
