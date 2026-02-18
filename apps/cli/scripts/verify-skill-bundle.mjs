import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDir, "..");
const targetSkillRoot = join(cliRoot, "skill-bundle", "openclaw-skill");

const requiredPaths = [
  join(targetSkillRoot, "skill", "SKILL.md"),
  join(targetSkillRoot, "skill", "references", "clawdentity-protocol.md"),
  join(targetSkillRoot, "dist", "relay-to-peer.mjs"),
];

async function main() {
  const missingPaths = [];
  for (const path of requiredPaths) {
    try {
      await access(path, constants.R_OK);
    } catch {
      missingPaths.push(path);
    }
  }

  if (missingPaths.length > 0) {
    const renderedPaths = missingPaths.map((path) => `- ${path}`).join("\n");
    throw new Error(
      `[verify-skill-bundle] Missing required bundled artifacts:\n${renderedPaths}\nRun: pnpm -F @clawdentity/openclaw-skill build && pnpm -F clawdentity run sync:skill-bundle`,
    );
  }

  process.stdout.write(
    `[verify-skill-bundle] Verified ${requiredPaths.length} bundled artifacts in ${targetSkillRoot}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
