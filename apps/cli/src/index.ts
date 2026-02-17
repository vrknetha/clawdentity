import { createRequire } from "node:module";
import { Command } from "commander";
import { createAdminCommand } from "./commands/admin.js";
import { createAgentCommand } from "./commands/agent.js";
import { createApiKeyCommand } from "./commands/api-key.js";
import { createConfigCommand } from "./commands/config.js";
import { createConnectorCommand } from "./commands/connector.js";
import { createInviteCommand } from "./commands/invite.js";
import { createOpenclawCommand } from "./commands/openclaw.js";
import { createVerifyCommand } from "./commands/verify.js";

const require = createRequire(import.meta.url);

const resolveCliVersion = (): string => {
  const packageJson = require("../package.json") as { version?: unknown };

  if (
    typeof packageJson.version === "string" &&
    packageJson.version.length > 0
  ) {
    return packageJson.version;
  }

  throw new Error("Unable to resolve CLI version from package metadata.");
};

export const CLI_VERSION = resolveCliVersion();

export const createProgram = (): Command => {
  return new Command("clawdentity")
    .description("Clawdentity CLI - Agent identity management")
    .version(CLI_VERSION)
    .addCommand(createAdminCommand())
    .addCommand(createAgentCommand())
    .addCommand(createApiKeyCommand())
    .addCommand(createConnectorCommand())
    .addCommand(createConfigCommand())
    .addCommand(createInviteCommand())
    .addCommand(createOpenclawCommand())
    .addCommand(createVerifyCommand());
};
