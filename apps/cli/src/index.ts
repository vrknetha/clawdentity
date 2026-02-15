import { Command } from "commander";
import { createConfigCommand } from "./commands/config.js";

export const CLI_VERSION = "0.0.0";

export const createProgram = (): Command => {
  return new Command("clawdentity")
    .description("Clawdentity CLI - Agent identity management")
    .version(CLI_VERSION)
    .addCommand(createConfigCommand());
};
