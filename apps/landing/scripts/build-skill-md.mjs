import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const landingRoot = path.resolve(scriptDir, "..");

const skillSourcePath = path.resolve(
  repoRoot,
  "apps",
  "openclaw-skill",
  "skill",
  "SKILL.md",
);

const references = [
  {
    title: "Clawdentity Protocol Reference",
    sourceLabel: "apps/openclaw-skill/skill/references/clawdentity-protocol.md",
    path: path.resolve(
      repoRoot,
      "apps",
      "openclaw-skill",
      "skill",
      "references",
      "clawdentity-protocol.md",
    ),
  },
  {
    title: "Clawdentity Registry Reference",
    sourceLabel: "apps/openclaw-skill/skill/references/clawdentity-registry.md",
    path: path.resolve(
      repoRoot,
      "apps",
      "openclaw-skill",
      "skill",
      "references",
      "clawdentity-registry.md",
    ),
  },
  {
    title: "Clawdentity Environment Reference",
    sourceLabel:
      "apps/openclaw-skill/skill/references/clawdentity-environment.md",
    path: path.resolve(
      repoRoot,
      "apps",
      "openclaw-skill",
      "skill",
      "references",
      "clawdentity-environment.md",
    ),
  },
];

const outputPath = path.resolve(landingRoot, "public", "skill.md");

function withTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function readUtf8(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function buildSkillMarkdown() {
  const baseSkill = await readUtf8(skillSourcePath);

  const referenceBlocks = [];
  for (const reference of references) {
    const referenceContent = withTrailingNewline(
      await readUtf8(reference.path),
    );
    const section = [
      "---",
      "",
      `## ${reference.title}`,
      "",
      `Source: \`${reference.sourceLabel}\``,
      "",
      referenceContent,
    ].join("\n");
    referenceBlocks.push(section);
  }

  const mergedContent = [
    withTrailingNewline(baseSkill),
    "---",
    "",
    "# Appended References",
    "",
    referenceBlocks.join("\n"),
  ].join("\n");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, mergedContent, "utf8");
  process.stdout.write(`Generated ${outputPath}\n`);
}

buildSkillMarkdown().catch((error) => {
  process.stderr.write(`Failed to generate skill markdown: ${error.message}\n`);
  process.exitCode = 1;
});
