import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

async function tryRead(path) {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

async function main() {
  await assertReadable(sourceSkillDirectory, "skill directory");

  const sourceRelayContent = await tryRead(sourceRelayModule);
  const bundledRelayContent = await tryRead(targetRelayModule);
  const relayModuleContent = sourceRelayContent ?? bundledRelayContent;

  if (relayModuleContent === undefined) {
    throw new Error(
      `[sync-skill-bundle] Missing required relay module at ${sourceRelayModule}. Build @clawdentity/openclaw-skill first.`,
    );
  }

  await rm(targetSkillRoot, { recursive: true, force: true });
  await mkdir(join(targetSkillRoot, "dist"), { recursive: true });

  await cp(sourceSkillDirectory, join(targetSkillRoot, "skill"), {
    recursive: true,
  });
  await writeFile(targetRelayModule, relayModuleContent);

  process.stdout.write(
    `[sync-skill-bundle] Bundled skill assets into ${targetSkillRoot}\n`,
  );
  if (sourceRelayContent === undefined) {
    process.stdout.write(
      "[sync-skill-bundle] Source relay build missing; reused existing bundled relay artifact.\n",
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
