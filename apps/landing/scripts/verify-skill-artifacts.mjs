import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");

const sourceSkill = join(
  repoRoot,
  "apps",
  "openclaw-skill",
  "skill",
  "SKILL.md",
);
const landingSkill = join(repoRoot, "apps", "landing", "public", "skill.md");
const rustSkill = join(
  repoRoot,
  "crates",
  "clawdentity-core",
  "assets",
  "openclaw-skill",
  "skill",
  "SKILL.md",
);
const sourceTransform = join(
  repoRoot,
  "apps",
  "openclaw-skill",
  "dist",
  "relay-to-peer.mjs",
);
const rustTransform = join(
  repoRoot,
  "crates",
  "clawdentity-core",
  "assets",
  "openclaw-skill",
  "dist",
  "relay-to-peer.mjs",
);

async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}

async function main() {
  const [
    source,
    landing,
    rustSkillBody,
    sourceTransformBody,
    rustTransformBody,
  ] = await Promise.all([
    readUtf8(sourceSkill),
    readUtf8(landingSkill),
    readUtf8(rustSkill),
    readUtf8(sourceTransform),
    readUtf8(rustTransform),
  ]);

  if (!landing.startsWith(source)) {
    throw new Error(
      "[verify-skill-artifacts] landing skill.md is not derived from apps/openclaw-skill/skill/SKILL.md",
    );
  }

  if (rustSkillBody !== source) {
    throw new Error(
      "[verify-skill-artifacts] Rust skill asset does not match apps/openclaw-skill/skill/SKILL.md",
    );
  }

  if (rustTransformBody !== sourceTransformBody) {
    throw new Error(
      "[verify-skill-artifacts] Rust relay transform asset does not match apps/openclaw-skill/dist/relay-to-peer.mjs",
    );
  }

  process.stdout.write(
    "[verify-skill-artifacts] landing and Rust skill artifacts are in sync\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
