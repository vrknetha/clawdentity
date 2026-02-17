import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts", "src/postinstall.ts"],
  format: ["esm"],
  bundle: true,
  splitting: false,
  external: ["ws"],
  noExternal: [
    "@clawdentity/connector",
    "@clawdentity/protocol",
    "@clawdentity/sdk",
  ],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
