import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseBooleanFlag(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes"
  ) {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }

  return undefined;
}

const packageRoot = dirname(fileURLToPath(import.meta.url));
const bundledPostinstallPath = join(packageRoot, "dist", "postinstall.js");
const skillRequested = parseBooleanFlag(process.env.npm_config_skill) === true;

try {
  await access(bundledPostinstallPath, constants.R_OK);
  await import(pathToFileURL(bundledPostinstallPath).href);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    if (skillRequested) {
      process.stderr.write(
        `[clawdentity] skill install failed: build artifact not found at ${bundledPostinstallPath}\n`,
      );
      process.exitCode = 1;
    }
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[clawdentity] postinstall failed: ${message}\n`);
    process.exitCode = 1;
  }
}
