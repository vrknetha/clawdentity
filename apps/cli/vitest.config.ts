import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@clawdentity/common": fileURLToPath(
        new URL("../../packages/common/src/index.ts", import.meta.url),
      ),
      "@clawdentity/connector": fileURLToPath(
        new URL("../../packages/connector/src/index.ts", import.meta.url),
      ),
      "@clawdentity/protocol": fileURLToPath(
        new URL("../../packages/protocol/src/index.ts", import.meta.url),
      ),
      "@clawdentity/sdk": fileURLToPath(
        new URL("../../packages/sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
  },
});
