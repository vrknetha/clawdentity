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
const defaultSiteBaseUrl = "https://clawdentity.com";

function withTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function resolveSiteBaseUrl() {
  const rawOverride = process.env.CLAWDENTITY_SITE_BASE_URL?.trim();
  if (!rawOverride) {
    return defaultSiteBaseUrl;
  }
  return trimTrailingSlash(rawOverride);
}

function renderSkillContent(baseSkill, siteBaseUrl) {
  const replacements = [
    ["https://clawdentity.com/skill.md", `${siteBaseUrl}/skill.md`],
    ["https://clawdentity.com/install.sh", `${siteBaseUrl}/install.sh`],
    ["https://clawdentity.com/install.ps1", `${siteBaseUrl}/install.ps1`],
  ];

  return replacements.reduce(
    (rendered, [from, to]) => rendered.replaceAll(from, to),
    baseSkill,
  );
}

async function readUtf8(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function buildSkillMarkdown() {
  const siteBaseUrl = resolveSiteBaseUrl();
  const baseSkill = renderSkillContent(
    await readUtf8(skillSourcePath),
    siteBaseUrl,
  );

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
