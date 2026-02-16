import { Command } from "commander";
import { createAdminCommand } from "./commands/admin.js";
import { createAgentCommand } from "./commands/agent.js";
import { createApiKeyCommand } from "./commands/api-key.js";
import { createConfigCommand } from "./commands/config.js";
import { createOpenclawCommand } from "./commands/openclaw.js";
import { createVerifyCommand } from "./commands/verify.js";

export const CLI_VERSION = "0.0.0";

export const createProgram = (): Command => {
  return new Command("clawdentity")
    .description("Clawdentity CLI - Agent identity management")
    .version(CLI_VERSION)
    .addCommand(createAdminCommand())
    .addCommand(createAgentCommand())
    .addCommand(createApiKeyCommand())
    .addCommand(createConfigCommand())
    .addCommand(createOpenclawCommand())
    .addCommand(createVerifyCommand());
};
