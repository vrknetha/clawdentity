import { Command } from "commander";
import { writeStdoutLine } from "../../io.js";
import { withErrorHandling } from "../helpers.js";
import {
  DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
  DEFAULT_STATUS_WAIT_SECONDS,
  logger,
  parsePositiveIntegerOption,
} from "./common.js";
import {
  confirmPairing,
  getPairingStatus,
  startPairing,
  waitForPairingStatus,
} from "./service.js";
import type {
  PairCommandDependencies,
  PairConfirmOptions,
  PairStartOptions,
  PairStatusOptions,
} from "./types.js";

export const createPairCommand = (
  dependencies: PairCommandDependencies = {},
): Command => {
  const pairCommand = new Command("pair").description(
    "Manage proxy trust pairing between agents",
  );

  pairCommand
    .command("start <agentName>")
    .description("Start pairing and issue one-time pairing ticket")
    .option("--ttl-seconds <seconds>", "Pairing ticket expiry in seconds")
    .option("--qr", "Generate a local QR file for sharing")
    .option("--qr-output <path>", "Write QR PNG to a specific file path")
    .option(
      "--wait",
      "Wait for responder confirmation and auto-save peer on initiator",
    )
    .option(
      "--wait-seconds <seconds>",
      "Max seconds to poll for confirmation (default: 300)",
    )
    .option(
      "--poll-interval-seconds <seconds>",
      "Polling interval in seconds while waiting (default: 3)",
    )
    .action(
      withErrorHandling(
        "pair start",
        async (agentName: string, options: PairStartOptions) => {
          const result = await startPairing(agentName, options, dependencies);

          logger.info("cli.pair_started", {
            initiatorAgentDid: result.initiatorAgentDid,
            proxyUrl: result.proxyUrl,
            expiresAt: result.expiresAt,
            qrPath: result.qrPath,
          });

          writeStdoutLine("Pairing ticket created");
          writeStdoutLine(`Ticket: ${result.ticket}`);
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          writeStdoutLine(`Expires At: ${result.expiresAt}`);
          if (result.qrPath) {
            writeStdoutLine(`QR File: ${result.qrPath}`);
          }

          if (options.wait === true) {
            const waitSeconds = parsePositiveIntegerOption({
              value: options.waitSeconds,
              optionName: "waitSeconds",
              defaultValue: DEFAULT_STATUS_WAIT_SECONDS,
            });
            const pollIntervalSeconds = parsePositiveIntegerOption({
              value: options.pollIntervalSeconds,
              optionName: "pollIntervalSeconds",
              defaultValue: DEFAULT_STATUS_POLL_INTERVAL_SECONDS,
            });

            writeStdoutLine(
              `Waiting for confirmation (timeout=${waitSeconds}s, interval=${pollIntervalSeconds}s) ...`,
            );

            const status = await waitForPairingStatus({
              agentName,
              ticket: result.ticket,
              waitSeconds,
              pollIntervalSeconds,
              dependencies,
            });

            logger.info("cli.pair_status_confirmed_after_start", {
              initiatorAgentDid: status.initiatorAgentDid,
              responderAgentDid: status.responderAgentDid,
              peerAlias: status.peerAlias,
            });

            writeStdoutLine("Pairing confirmed");
            writeStdoutLine(`Status: ${status.status}`);
            if (status.initiatorAgentDid) {
              writeStdoutLine(
                `Initiator Agent DID: ${status.initiatorAgentDid}`,
              );
            }
            if (status.responderAgentDid) {
              writeStdoutLine(
                `Responder Agent DID: ${status.responderAgentDid}`,
              );
            }
            if (status.responderProfile) {
              writeStdoutLine(
                `Responder Agent Name: ${status.responderProfile.agentName}`,
              );
              writeStdoutLine(
                `Responder Human Name: ${status.responderProfile.humanName}`,
              );
            }
            if (status.peerAlias) {
              writeStdoutLine(`Peer alias saved: ${status.peerAlias}`);
            }
          }
        },
      ),
    );

  pairCommand
    .command("confirm <agentName>")
    .description("Confirm pairing using one-time pairing ticket")
    .option("--ticket <ticket>", "One-time pairing ticket (clwpair1_...)")
    .option("--qr-file <path>", "Path to pairing QR PNG file")
    .action(
      withErrorHandling(
        "pair confirm",
        async (agentName: string, options: PairConfirmOptions) => {
          const result = await confirmPairing(agentName, options, dependencies);

          logger.info("cli.pair_confirmed", {
            initiatorAgentDid: result.initiatorAgentDid,
            responderAgentDid: result.responderAgentDid,
            proxyUrl: result.proxyUrl,
            peerAlias: result.peerAlias,
          });

          writeStdoutLine("Pairing confirmed");
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          writeStdoutLine(`Responder Agent DID: ${result.responderAgentDid}`);
          writeStdoutLine(
            `Responder Agent Name: ${result.responderProfile.agentName}`,
          );
          writeStdoutLine(
            `Responder Human Name: ${result.responderProfile.humanName}`,
          );
          writeStdoutLine(`Paired: ${result.paired ? "true" : "false"}`);
          if (result.peerAlias) {
            writeStdoutLine(`Peer alias saved: ${result.peerAlias}`);
          }
        },
      ),
    );

  pairCommand
    .command("status <agentName>")
    .description("Check pairing ticket status and sync local peer on confirm")
    .option("--ticket <ticket>", "One-time pairing ticket (clwpair1_...)")
    .option("--wait", "Poll until ticket is confirmed or timeout is reached")
    .option(
      "--wait-seconds <seconds>",
      "Max seconds to poll for confirmation (default: 300)",
    )
    .option(
      "--poll-interval-seconds <seconds>",
      "Polling interval in seconds while waiting (default: 3)",
    )
    .action(
      withErrorHandling(
        "pair status",
        async (agentName: string, options: PairStatusOptions) => {
          const result = await getPairingStatus(
            agentName,
            options,
            dependencies,
          );

          logger.info("cli.pair_status", {
            initiatorAgentDid: result.initiatorAgentDid,
            responderAgentDid: result.responderAgentDid,
            status: result.status,
            proxyUrl: result.proxyUrl,
            peerAlias: result.peerAlias,
          });

          writeStdoutLine(`Status: ${result.status}`);
          writeStdoutLine(`Initiator Agent DID: ${result.initiatorAgentDid}`);
          writeStdoutLine(
            `Initiator Agent Name: ${result.initiatorProfile.agentName}`,
          );
          writeStdoutLine(
            `Initiator Human Name: ${result.initiatorProfile.humanName}`,
          );
          if (result.responderAgentDid) {
            writeStdoutLine(`Responder Agent DID: ${result.responderAgentDid}`);
          }
          if (result.responderProfile) {
            writeStdoutLine(
              `Responder Agent Name: ${result.responderProfile.agentName}`,
            );
            writeStdoutLine(
              `Responder Human Name: ${result.responderProfile.humanName}`,
            );
          }
          writeStdoutLine(`Expires At: ${result.expiresAt}`);
          if (result.confirmedAt) {
            writeStdoutLine(`Confirmed At: ${result.confirmedAt}`);
          }
          if (result.peerAlias) {
            writeStdoutLine(`Peer alias saved: ${result.peerAlias}`);
          }
        },
      ),
    );

  return pairCommand;
};
