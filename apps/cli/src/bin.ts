import { createLogger } from "@clawdentity/sdk";
import { createProgram } from "./index.js";
import { writeStderrLine } from "./io.js";

const logger = createLogger({ service: "cli", module: "bin" });

createProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);

    logger.error("cli.execution_failed", { errorMessage: message });
    writeStderrLine(message);
  });
