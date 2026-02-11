import path from "node:path";

export default {
  "*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml,md}": [
    "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
  ],
  "*.{ts,tsx,js,jsx}": (files) => {
    if (files.length === 0) {
      return [];
    }

    const relativeFiles = files.map((file) => path.relative(process.cwd(), file));
    return [
      `pnpm exec nx affected -t typecheck --files=${relativeFiles.join(",")}`,
    ];
  },
};
