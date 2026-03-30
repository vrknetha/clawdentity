import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@clawdentity/common": fileURLToPath(
        new URL("../common/src/index.ts", import.meta.url),
      ),
      "@clawdentity/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
  },
});
