import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../install-skill-mode.js", () => ({
  formatSkillInstallError: vi.fn((error: unknown) => {
    if (error instanceof Error) {
      return `formatted: ${error.message}`;
    }

    return `formatted: ${String(error)}`;
  }),
  installOpenclawSkillArtifacts: vi.fn(),
}));

import {
  formatSkillInstallError,
  installOpenclawSkillArtifacts,
  type SkillInstallResult,
} from "../install-skill-mode.js";
import { createSkillCommand } from "./skill.js";

const mockedInstallOpenclawSkillArtifacts = vi.mocked(
  installOpenclawSkillArtifacts,
);
const mockedFormatSkillInstallError = vi.mocked(formatSkillInstallError);

type RunResult = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
};

const runSkillCommand = async (args: string[]): Promise<RunResult> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });

  process.exitCode = undefined;

  const command = createSkillCommand();
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "skill", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
};

const toResult = (openclawDir: string): SkillInstallResult => ({
  homeDir: "/home/test",
  openclawDir,
  skillPackageRoot: "/pkg/openclaw-skill",
  targetSkillDirectory: `${openclawDir}/skills/clawdentity-openclaw-relay`,
  records: [
    {
      action: "installed",
      sourcePath: "/pkg/openclaw-skill/skill/SKILL.md",
      targetPath: `${openclawDir}/skills/clawdentity-openclaw-relay/SKILL.md`,
    },
  ],
});

describe("skill command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("installs skill artifacts with default OpenClaw dir", async () => {
    mockedInstallOpenclawSkillArtifacts.mockResolvedValueOnce(
      toResult("/home/test/.openclaw"),
    );

    const result = await runSkillCommand(["install"]);

    expect(mockedInstallOpenclawSkillArtifacts).toHaveBeenCalledWith({
      openclawDir: undefined,
      skillPackageRoot: undefined,
    });
    expect(result.stdout).toContain("OpenClaw dir: /home/test/.openclaw");
    expect(result.stdout).toContain("installed=1 updated=0 unchanged=0");
    expect(result.exitCode).toBeUndefined();
  });

  it("installs skill artifacts for each provided OpenClaw dir", async () => {
    mockedInstallOpenclawSkillArtifacts
      .mockResolvedValueOnce(toResult("/profiles/alpha"))
      .mockResolvedValueOnce(toResult("/profiles/beta"));

    const result = await runSkillCommand([
      "install",
      "--openclaw-dir",
      "/profiles/alpha",
      "--openclaw-dir",
      "/profiles/beta",
    ]);

    expect(mockedInstallOpenclawSkillArtifacts).toHaveBeenNthCalledWith(1, {
      openclawDir: "/profiles/alpha",
      skillPackageRoot: undefined,
    });
    expect(mockedInstallOpenclawSkillArtifacts).toHaveBeenNthCalledWith(2, {
      openclawDir: "/profiles/beta",
      skillPackageRoot: undefined,
    });
    expect(result.stdout).toContain("OpenClaw dir: /profiles/alpha");
    expect(result.stdout).toContain("OpenClaw dir: /profiles/beta");
  });

  it("prints machine-readable output with --json", async () => {
    mockedInstallOpenclawSkillArtifacts.mockResolvedValueOnce(
      toResult("/home/test/.openclaw"),
    );

    const result = await runSkillCommand(["install", "--json"]);

    const parsed = JSON.parse(result.stdout) as {
      installs: SkillInstallResult[];
    };

    expect(parsed.installs).toHaveLength(1);
    expect(parsed.installs[0]?.openclawDir).toBe("/home/test/.openclaw");
  });

  it("formats install errors and exits non-zero", async () => {
    mockedInstallOpenclawSkillArtifacts.mockRejectedValueOnce(
      new Error("artifact missing"),
    );

    const result = await runSkillCommand(["install"]);

    expect(mockedFormatSkillInstallError).toHaveBeenCalled();
    expect(result.stderr).toContain("formatted: artifact missing");
    expect(result.exitCode).toBe(1);
  });
});
