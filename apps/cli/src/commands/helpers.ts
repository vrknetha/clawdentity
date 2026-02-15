import { createLogger } from "@clawdentity/sdk";
import { writeStderrLine } from "../io.js";

const logger = createLogger({ service: "cli", module: "commands" });

export const withErrorHandling = <T extends unknown[]>(
  command: string,
  handler: (...args: T) => Promise<void>,
) => {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      process.exitCode = 1;
      const message = error instanceof Error ? error.message : String(error);

      logger.error("cli.command_failed", {
        command,
        errorMessage: message,
      });
      writeStderrLine(message);
    }
  };
};
