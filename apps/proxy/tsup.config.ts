import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/server.ts",
    "src/node-server.ts",
    "src/worker.ts",
    "src/bin.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
});
