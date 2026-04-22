import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", "..");

const sourceSkill = join(repoRoot, "apps", "agent-skill", "skill", "SKILL.md");
const landingSkill = join(repoRoot, "apps", "landing", "public", "skill.md");
const landingAgentSkill = join(
  repoRoot,
  "apps",
  "landing",
  "public",
  "agent-skill.md",
);

async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}

async function main() {
  const [source, landing, landingAgent] = await Promise.all([
    readUtf8(sourceSkill),
    readUtf8(landingSkill),
    readUtf8(landingAgentSkill),
  ]);

  if (!landing.startsWith(source)) {
    throw new Error(
      "[verify-skill-artifacts] landing skill.md is not derived from apps/agent-skill/skill/SKILL.md",
    );
  }
  if (!landingAgent.startsWith(source)) {
    throw new Error(
      "[verify-skill-artifacts] landing agent-skill.md is not derived from apps/agent-skill/skill/SKILL.md",
    );
  }
  process.stdout.write(
    "[verify-skill-artifacts] landing skill artifacts are in sync\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
