import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const bundledPostinstallPath = join(packageRoot, "dist", "postinstall.js");

try {
  await import(pathToFileURL(bundledPostinstallPath).href);
} catch (error) {
  if (!(error && typeof error === "object" && error.code === "ENOENT")) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[clawdentity] postinstall failed: ${message}\n`);
    process.exitCode = 1;
  }
}
