import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@clawdentity/protocol": resolve(
        rootDir,
        "../../packages/protocol/src/index.ts",
      ),
      "@clawdentity/sdk": resolve(rootDir, "../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    globals: true,
  },
});
