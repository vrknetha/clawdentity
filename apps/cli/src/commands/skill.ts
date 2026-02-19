import { Command } from "commander";
import {
  formatSkillInstallError,
  installOpenclawSkillArtifacts,
  type SkillInstallResult,
} from "../install-skill-mode.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

type SkillInstallCommandOptions = {
  openclawDir?: string[];
  skillPackageRoot?: string;
  json?: boolean;
};

function collectStringOption(value: string, previous: string[]): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return previous;
  }

  return [...previous, trimmed];
}

function toInstallSummary(records: SkillInstallResult["records"]): string {
  const installed = records.filter((record) => record.action === "installed");
  const updated = records.filter((record) => record.action === "updated");
  const unchanged = records.filter((record) => record.action === "unchanged");

  return `installed=${installed.length} updated=${updated.length} unchanged=${unchanged.length}`;
}

async function runSkillInstall(
  options: SkillInstallCommandOptions,
): Promise<SkillInstallResult[]> {
  const requestedDirs = (options.openclawDir ?? []).filter(
    (dir) => dir.trim().length > 0,
  );
  const dirs = requestedDirs.length > 0 ? requestedDirs : [undefined];
  const results: SkillInstallResult[] = [];

  for (const openclawDir of dirs) {
    const result = await installOpenclawSkillArtifacts({
      openclawDir,
      skillPackageRoot: options.skillPackageRoot,
    });
    results.push(result);
  }

  return results;
}

export const createSkillCommand = (): Command => {
  const skillCommand = new Command("skill").description(
    "Install and manage Clawdentity skill artifacts",
  );

  skillCommand
    .command("install")
    .description("Install Clawdentity OpenClaw skill artifacts")
    .option(
      "--openclaw-dir <path>",
      "OpenClaw state directory target (repeat for multiple profiles)",
      collectStringOption,
      [],
    )
    .option(
      "--skill-package-root <path>",
      "Override skill package root (defaults to bundled assets)",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      withErrorHandling(
        "skill install",
        async (options: SkillInstallCommandOptions) => {
          let results: SkillInstallResult[];
          try {
            results = await runSkillInstall(options);
          } catch (error) {
            throw new Error(formatSkillInstallError(error));
          }

          if (options.json) {
            writeStdoutLine(JSON.stringify({ installs: results }, null, 2));
            return;
          }

          for (const result of results) {
            writeStdoutLine(`OpenClaw dir: ${result.openclawDir}`);
            writeStdoutLine(`Skill source: ${result.skillPackageRoot}`);
            writeStdoutLine(`Target skill dir: ${result.targetSkillDirectory}`);
            for (const record of result.records) {
              writeStdoutLine(
                `${record.action}: ${record.targetPath} (source: ${record.sourcePath})`,
              );
            }
            writeStdoutLine(toInstallSummary(result.records));
          }
        },
      ),
    );

  return skillCommand;
};
