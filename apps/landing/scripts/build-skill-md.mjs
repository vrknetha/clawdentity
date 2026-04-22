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
  "agent-skill",
  "skill",
  "SKILL.md",
);
const outputAgentSkillPath = path.resolve(
  landingRoot,
  "public",
  "agent-skill.md",
);
const outputCompatSkillPath = path.resolve(landingRoot, "public", "skill.md");
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
    ["https://clawdentity.com/agent-skill.md", `${siteBaseUrl}/agent-skill.md`],
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
  const mergedContent = renderSkillContent(
    await readUtf8(skillSourcePath),
    siteBaseUrl,
  );
  await fs.mkdir(path.dirname(outputAgentSkillPath), { recursive: true });
  await fs.writeFile(
    outputAgentSkillPath,
    withTrailingNewline(mergedContent),
    "utf8",
  );
  await fs.writeFile(
    outputCompatSkillPath,
    withTrailingNewline(mergedContent),
    "utf8",
  );
  process.stdout.write(`Generated ${outputAgentSkillPath}\n`);
  process.stdout.write(`Generated ${outputCompatSkillPath}\n`);
}

buildSkillMarkdown().catch((error) => {
  process.stderr.write(`Failed to generate skill markdown: ${error.message}\n`);
  process.exitCode = 1;
});
