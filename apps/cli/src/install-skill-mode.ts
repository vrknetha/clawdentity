import { constants, existsSync } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OPENCLAW_DIR_NAME = ".openclaw";
const SKILL_PACKAGE_NAME = "@clawdentity/openclaw-skill";
const SKILL_DIR_NAME = "clawdentity-openclaw-relay";
const RELAY_MODULE_FILE_NAME = "relay-to-peer.mjs";

type InstallAction = "installed" | "updated" | "unchanged";

export type SkillInstallRecord = {
  action: InstallAction;
  sourcePath: string;
  targetPath: string;
};

export type SkillInstallResult = {
  homeDir: string;
  openclawDir: string;
  skillPackageRoot: string;
  targetSkillDirectory: string;
  records: SkillInstallRecord[];
};

type SkillInstallOptions = {
  homeDir?: string;
  openclawDir?: string;
  skillPackageRoot?: string;
  env?: NodeJS.ProcessEnv;
};

type SkillInstallArtifact = {
  sourcePath: string;
  targetPath: string;
};

type SkillInstallErrorCode =
  | "CLI_SKILL_PACKAGE_NOT_FOUND"
  | "CLI_SKILL_ARTIFACT_MISSING"
  | "CLI_SKILL_REFERENCE_DIR_EMPTY";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class SkillInstallError extends Error {
  public readonly code: SkillInstallErrorCode;
  public readonly details: Record<string, string>;

  public constructor(input: {
    code: SkillInstallErrorCode;
    message: string;
    details?: Record<string, string>;
  }) {
    super(input.message);
    this.name = "SkillInstallError";
    this.code = input.code;
    this.details = input.details ?? {};
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function resolveHomeDir(inputHomeDir?: string): string {
  if (typeof inputHomeDir === "string" && inputHomeDir.trim().length > 0) {
    return inputHomeDir.trim();
  }

  return homedir();
}

function resolveOpenclawDir(
  homeDir: string,
  inputOpenclawDir?: string,
): string {
  if (
    typeof inputOpenclawDir === "string" &&
    inputOpenclawDir.trim().length > 0
  ) {
    return inputOpenclawDir.trim();
  }

  return join(homeDir, OPENCLAW_DIR_NAME);
}

function resolveSkillPackageRoot(input: {
  skillPackageRoot?: string;
  env: NodeJS.ProcessEnv;
}): string {
  if (
    typeof input.skillPackageRoot === "string" &&
    input.skillPackageRoot.trim().length > 0
  ) {
    return input.skillPackageRoot.trim();
  }

  const overriddenRoot = input.env.CLAWDENTITY_SKILL_PACKAGE_ROOT;
  if (typeof overriddenRoot === "string" && overriddenRoot.trim().length > 0) {
    return overriddenRoot.trim();
  }

  const bundledSkillRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "skill-bundle",
    "openclaw-skill",
  );
  if (existsSync(bundledSkillRoot)) {
    return bundledSkillRoot;
  }

  const require = createRequire(import.meta.url);

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve(`${SKILL_PACKAGE_NAME}/package.json`);
    return dirname(packageJsonPath);
  } catch {
    const workspaceFallbackRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "openclaw-skill",
    );
    if (existsSync(workspaceFallbackRoot)) {
      return workspaceFallbackRoot;
    }

    throw new SkillInstallError({
      code: "CLI_SKILL_PACKAGE_NOT_FOUND",
      message:
        "Skill artifacts are unavailable. Set CLAWDENTITY_SKILL_PACKAGE_ROOT or provide bundled skill assets before running skill install.",
      details: {
        packageName: SKILL_PACKAGE_NAME,
        bundledSkillRoot,
        workspaceFallbackRoot,
      },
    });
  }
}

async function assertReadableFile(
  filePath: string,
  details: Record<string, string>,
): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new SkillInstallError({
        code: "CLI_SKILL_ARTIFACT_MISSING",
        message: "Required skill artifact is missing",
        details: {
          ...details,
          sourcePath: filePath,
        },
      });
    }

    throw error;
  }
}

async function listFilesRecursively(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function resolveArtifacts(input: {
  skillPackageRoot: string;
  openclawDir: string;
}): Promise<SkillInstallArtifact[]> {
  const skillRoot = join(input.skillPackageRoot, "skill");
  const skillDocSource = join(skillRoot, "SKILL.md");
  const referencesRoot = join(skillRoot, "references");
  const relaySource = join(
    input.skillPackageRoot,
    "dist",
    RELAY_MODULE_FILE_NAME,
  );

  await assertReadableFile(skillDocSource, {
    artifact: "SKILL.md",
  });
  await assertReadableFile(relaySource, {
    artifact: RELAY_MODULE_FILE_NAME,
  });

  let referenceFiles: string[];
  try {
    referenceFiles = await listFilesRecursively(referencesRoot);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new SkillInstallError({
        code: "CLI_SKILL_ARTIFACT_MISSING",
        message: "Required skill references directory is missing",
        details: {
          sourcePath: referencesRoot,
          artifact: "references",
        },
      });
    }

    throw error;
  }

  if (referenceFiles.length === 0) {
    throw new SkillInstallError({
      code: "CLI_SKILL_REFERENCE_DIR_EMPTY",
      message: "Required skill references directory is empty",
      details: {
        sourcePath: referencesRoot,
      },
    });
  }

  const targetSkillRoot = join(input.openclawDir, "skills", SKILL_DIR_NAME);

  const artifacts: SkillInstallArtifact[] = [
    {
      sourcePath: skillDocSource,
      targetPath: join(targetSkillRoot, "SKILL.md"),
    },
    {
      sourcePath: relaySource,
      targetPath: join(targetSkillRoot, RELAY_MODULE_FILE_NAME),
    },
    {
      sourcePath: relaySource,
      targetPath: join(
        input.openclawDir,
        "hooks",
        "transforms",
        RELAY_MODULE_FILE_NAME,
      ),
    },
  ];

  for (const referenceFile of referenceFiles) {
    const relativePath = relative(referencesRoot, referenceFile);
    artifacts.push({
      sourcePath: referenceFile,
      targetPath: join(targetSkillRoot, "references", relativePath),
    });
  }

  return artifacts.sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath),
  );
}

async function copyArtifact(input: {
  sourcePath: string;
  targetPath: string;
}): Promise<InstallAction> {
  const sourceContent = await readFile(input.sourcePath);
  let existingContent: Buffer | undefined;

  try {
    existingContent = await readFile(input.targetPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (existingContent !== undefined && sourceContent.equals(existingContent)) {
    return "unchanged";
  }

  await mkdir(dirname(input.targetPath), { recursive: true });
  await copyFile(input.sourcePath, input.targetPath);

  if (existingContent !== undefined) {
    return "updated";
  }

  return "installed";
}

export async function installOpenclawSkillArtifacts(
  options: SkillInstallOptions = {},
): Promise<SkillInstallResult> {
  const env = options.env ?? process.env;
  const homeDir = resolveHomeDir(options.homeDir);
  const openclawDir = resolveOpenclawDir(homeDir, options.openclawDir);
  const skillPackageRoot = resolveSkillPackageRoot({
    skillPackageRoot: options.skillPackageRoot,
    env,
  });
  const artifacts = await resolveArtifacts({
    skillPackageRoot,
    openclawDir,
  });
  const records: SkillInstallRecord[] = [];

  for (const artifact of artifacts) {
    const action = await copyArtifact(artifact);
    records.push({
      action,
      sourcePath: artifact.sourcePath,
      targetPath: artifact.targetPath,
    });
  }

  return {
    homeDir,
    openclawDir,
    skillPackageRoot,
    targetSkillDirectory: join(openclawDir, "skills", SKILL_DIR_NAME),
    records,
  };
}

export function formatSkillInstallError(error: unknown): string {
  if (error instanceof SkillInstallError) {
    const details = Object.entries(error.details)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");

    if (details.length === 0) {
      return `${error.code}: ${error.message}`;
    }

    return `${error.code}: ${error.message} (${details})`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
