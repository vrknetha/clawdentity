import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const sourceRoot = path.resolve(repoRoot, "apps", "openclaw-skill");
const targetRoot = path.resolve(
  repoRoot,
  "crates",
  "clawdentity-core",
  "assets",
  "openclaw-skill",
);

const copyJobs = [
  {
    source: path.join(sourceRoot, "skill", "SKILL.md"),
    target: path.join(targetRoot, "skill", "SKILL.md"),
  },
  {
    source: path.join(
      sourceRoot,
      "skill",
      "references",
      "clawdentity-environment.md",
    ),
    target: path.join(
      targetRoot,
      "skill",
      "references",
      "clawdentity-environment.md",
    ),
  },
  {
    source: path.join(
      sourceRoot,
      "skill",
      "references",
      "clawdentity-protocol.md",
    ),
    target: path.join(
      targetRoot,
      "skill",
      "references",
      "clawdentity-protocol.md",
    ),
  },
  {
    source: path.join(
      sourceRoot,
      "skill",
      "references",
      "clawdentity-registry.md",
    ),
    target: path.join(
      targetRoot,
      "skill",
      "references",
      "clawdentity-registry.md",
    ),
  },
  {
    source: path.join(sourceRoot, "dist", "relay-to-peer.mjs"),
    target: path.join(targetRoot, "dist", "relay-to-peer.mjs"),
  },
];

for (const job of copyJobs) {
  await stat(job.source);
  await mkdir(path.dirname(job.target), { recursive: true });
  await cp(job.source, job.target, { force: true });
  process.stdout.write(`synced ${path.relative(repoRoot, job.target)}\n`);
}
