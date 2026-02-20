import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@clawdentity/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
      "@clawdentity/sdk": fileURLToPath(
        new URL("../sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
  },
});
