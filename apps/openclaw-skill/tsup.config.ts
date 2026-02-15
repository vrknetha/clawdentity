import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "relay-to-peer": "src/transforms/relay-to-peer.ts",
  },
  format: ["esm"],
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node22",
  bundle: true,
  noExternal: [/.*/],
  dts: false,
  clean: true,
});
