import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Wrangler handles actual Worker bundling for deployment.
  // tsup is used only for type generation and local build validation.
  external: ["hono"],
});
