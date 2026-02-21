import { createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import { writeStdoutLine } from "../../io.js";
import { assertValidAgentName } from "../agent-name.js";
import { withErrorHandling } from "../helpers.js";
import { resolveWaitPromise } from "./runtime.js";
import {
  installConnectorServiceForAgent,
  startConnectorForAgent,
  uninstallConnectorServiceForAgent,
} from "./service.js";
import type {
  ConnectorCommandDependencies,
  ConnectorServiceInstallCommandOptions,
  ConnectorServiceUninstallCommandOptions,
  ConnectorStartCommandOptions,
} from "./types.js";

const logger = createLogger({ service: "cli", module: "connector" });

export function createConnectorCommand(
  dependencies: ConnectorCommandDependencies = {},
): Command {
  const connector = new Command("connector")
    .description("Run local connector runtime for OpenClaw relay handoff")
    .addCommand(
      new Command("start")
        .description("Start connector runtime for a local agent")
        .argument("<agentName>", "Local agent name")
        .option(
          "--proxy-ws-url <url>",
          "Proxy websocket URL (or CLAWDENTITY_PROXY_WS_URL)",
        )
        .option(
          "--openclaw-base-url <url>",
          "OpenClaw base URL (default OPENCLAW_BASE_URL or http://127.0.0.1:18789)",
        )
        .option(
          "--openclaw-hook-path <path>",
          "OpenClaw hooks path (default OPENCLAW_HOOK_PATH or /hooks/agent)",
        )
        .option(
          "--openclaw-hook-token <token>",
          "OpenClaw hooks token (default OPENCLAW_HOOK_TOKEN)",
        )
        .action(
          withErrorHandling(
            "connector start",
            async (
              agentNameInput: string,
              commandOptions: ConnectorStartCommandOptions,
            ) => {
              const agentName = assertValidAgentName(agentNameInput);

              writeStdoutLine(
                `Starting connector runtime for agent "${agentName}"...`,
              );

              const started = await startConnectorForAgent(
                agentName,
                {
                  proxyWsUrl: commandOptions.proxyWsUrl,
                  openclawBaseUrl: commandOptions.openclawBaseUrl,
                  openclawHookPath: commandOptions.openclawHookPath,
                  openclawHookToken: commandOptions.openclawHookToken,
                },
                dependencies,
              );

              writeStdoutLine(
                `Connector outbound endpoint: ${started.outboundUrl}`,
              );
              if (started.proxyWebsocketUrl) {
                writeStdoutLine(
                  `Connector proxy websocket: ${started.proxyWebsocketUrl}`,
                );
              }
              writeStdoutLine("Connector runtime is active.");

              const waitPromise = resolveWaitPromise(started.runtime);
              if (waitPromise) {
                await waitPromise;
              }
            },
          ),
        ),
    )
    .addCommand(
      new Command("service")
        .description("Install or remove connector autostart service")
        .addCommand(
          new Command("install")
            .description("Install and start connector service at login/restart")
            .argument("<agentName>", "Local agent name")
            .option(
              "--platform <platform>",
              "Service platform: auto | launchd | systemd",
            )
            .option(
              "--proxy-ws-url <url>",
              "Proxy websocket URL (or CLAWDENTITY_PROXY_WS_URL)",
            )
            .option(
              "--openclaw-base-url <url>",
              "OpenClaw base URL override for connector runtime",
            )
            .option(
              "--openclaw-hook-path <path>",
              "OpenClaw hooks path override for connector runtime",
            )
            .option(
              "--openclaw-hook-token <token>",
              "OpenClaw hooks token override for connector runtime",
            )
            .action(
              withErrorHandling(
                "connector service install",
                async (
                  agentNameInput: string,
                  commandOptions: ConnectorServiceInstallCommandOptions,
                ) => {
                  const agentName = assertValidAgentName(agentNameInput);
                  const installed = await installConnectorServiceForAgent(
                    agentName,
                    {
                      platform: commandOptions.platform,
                      proxyWsUrl: commandOptions.proxyWsUrl,
                      openclawBaseUrl: commandOptions.openclawBaseUrl,
                      openclawHookPath: commandOptions.openclawHookPath,
                      openclawHookToken: commandOptions.openclawHookToken,
                    },
                    dependencies,
                  );

                  writeStdoutLine(
                    `Connector service installed (${installed.platform}): ${installed.serviceName}`,
                  );
                  writeStdoutLine(`Service file: ${installed.serviceFilePath}`);
                },
              ),
            ),
        )
        .addCommand(
          new Command("uninstall")
            .description("Uninstall connector autostart service")
            .argument("<agentName>", "Local agent name")
            .option(
              "--platform <platform>",
              "Service platform: auto | launchd | systemd",
            )
            .action(
              withErrorHandling(
                "connector service uninstall",
                async (
                  agentNameInput: string,
                  commandOptions: ConnectorServiceUninstallCommandOptions,
                ) => {
                  const agentName = assertValidAgentName(agentNameInput);
                  const uninstalled = await uninstallConnectorServiceForAgent(
                    agentName,
                    {
                      platform: commandOptions.platform,
                    },
                    dependencies,
                  );

                  writeStdoutLine(
                    `Connector service uninstalled (${uninstalled.platform}): ${uninstalled.serviceName}`,
                  );
                  writeStdoutLine(
                    `Service file removed: ${uninstalled.serviceFilePath}`,
                  );
                },
              ),
            ),
        ),
    );

  logger.debug("cli.connector.command_registered", {
    command: "connector",
  });

  return connector;
}
