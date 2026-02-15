import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
