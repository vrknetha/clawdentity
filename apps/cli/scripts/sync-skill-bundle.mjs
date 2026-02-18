import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(scriptDir, "..");
const skillRoot = join(cliRoot, "..", "openclaw-skill");
const sourceSkillDirectory = join(skillRoot, "skill");
const sourceRelayModule = join(skillRoot, "dist", "relay-to-peer.mjs");
const targetSkillRoot = join(cliRoot, "skill-bundle", "openclaw-skill");
const targetRelayModule = join(targetSkillRoot, "dist", "relay-to-peer.mjs");

async function assertReadable(path, label) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(
      `[sync-skill-bundle] Missing required ${label} at ${path}. Build @clawdentity/openclaw-skill first.`,
    );
  }
}

async function main() {
  await assertReadable(sourceSkillDirectory, "skill directory");
  await assertReadable(sourceRelayModule, "relay module");

  await rm(targetSkillRoot, { recursive: true, force: true });
  await mkdir(join(targetSkillRoot, "dist"), { recursive: true });

  await cp(sourceSkillDirectory, join(targetSkillRoot, "skill"), {
    recursive: true,
  });
  await copyFile(sourceRelayModule, targetRelayModule);

  process.stdout.write(
    `[sync-skill-bundle] Bundled skill assets into ${targetSkillRoot}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
