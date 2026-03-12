import { writeFile } from "node:fs/promises";
import path from "node:path";

const assetPlatforms = [
  { platform: "linux-x86_64", ext: "tar.gz" },
  { platform: "linux-aarch64", ext: "tar.gz" },
  { platform: "macos-x86_64", ext: "tar.gz" },
  { platform: "macos-aarch64", ext: "tar.gz" },
  { platform: "windows-x86_64", ext: "zip" },
  { platform: "windows-aarch64", ext: "zip" },
];

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function requireArg(parsed, key) {
  const value = parsed[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required argument --${key}`);
  }

  return value.trim();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = requireArg(args, "version");
  const tag = requireArg(args, "tag");
  const baseUrl = trimTrailingSlash(requireArg(args, "base-url"));
  const publishedAt = requireArg(args, "published-at");
  const output = requireArg(args, "output");

  const assetBaseUrl = `${baseUrl}/rust/v${version}`;
  const checksumsFileName = `clawdentity-${version}-checksums.txt`;

  const manifest = {
    version,
    tag,
    publishedAt,
    assetBaseUrl,
    checksumsUrl: `${assetBaseUrl}/${checksumsFileName}`,
    assets: Object.fromEntries(
      assetPlatforms.map(({ platform, ext }) => {
        const fileName = `clawdentity-${version}-${platform}.${ext}`;
        return [
          platform,
          {
            fileName,
            url: `${assetBaseUrl}/${fileName}`,
          },
        ];
      }),
    ),
  };

  await writeFile(
    path.resolve(output),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(`Wrote release manifest to ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
