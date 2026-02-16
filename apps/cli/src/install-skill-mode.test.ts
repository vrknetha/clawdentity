import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillInstallError } from "./install-skill-mode.js";
import {
  installOpenclawSkillArtifacts,
  isSkillInstallRequested,
  runNpmSkillInstall,
} from "./install-skill-mode.js";

type SkillSandbox = {
  cleanup: () => void;
  homeDir: string;
  openclawDir: string;
  skillPackageRoot: string;
  referencesRoot: string;
};

function createSkillSandbox(): SkillSandbox {
  const root = mkdtempSync(join(tmpdir(), "clawdentity-skill-install-"));
  const homeDir = join(root, "home");
  const openclawDir = join(homeDir, ".openclaw");
  const skillPackageRoot = join(root, "openclaw-skill-package");
  const skillRoot = join(skillPackageRoot, "skill");
  const referencesRoot = join(skillRoot, "references");

  mkdirSync(referencesRoot, { recursive: true });
  mkdirSync(join(skillPackageRoot, "dist"), { recursive: true });
  mkdirSync(openclawDir, { recursive: true });

  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "# Clawdentity OpenClaw Relay Skill\n",
    "utf8",
  );
  writeFileSync(
    join(referencesRoot, "clawdentity-protocol.md"),
    "Protocol reference\n",
    "utf8",
  );
  writeFileSync(
    join(skillPackageRoot, "dist", "relay-to-peer.mjs"),
    "export default async function relayToPeer(){ return null; }\n",
    "utf8",
  );

  return {
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    homeDir,
    openclawDir,
    skillPackageRoot,
    referencesRoot,
  };
}

describe("install skill mode detection", () => {
  it("detects --skill from npm_config_skill env", () => {
    expect(isSkillInstallRequested({ npm_config_skill: "true" })).toBe(true);
    expect(isSkillInstallRequested({ npm_config_skill: "1" })).toBe(true);
    expect(isSkillInstallRequested({ npm_config_skill: "false" })).toBe(false);
  });

  it("detects --skill from npm_config_argv", () => {
    expect(
      isSkillInstallRequested({
        npm_config_argv: JSON.stringify({
          original: ["install", "clawdentity", "--skill"],
        }),
      }),
    ).toBe(true);

    expect(
      isSkillInstallRequested({
        npm_config_argv: JSON.stringify({
          original: ["install", "clawdentity"],
        }),
      }),
    ).toBe(false);
  });
});

describe("installOpenclawSkillArtifacts", () => {
  it("installs skill artifacts and remains idempotent on rerun", async () => {
    const sandbox = createSkillSandbox();

    try {
      const firstRun = await installOpenclawSkillArtifacts({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        skillPackageRoot: sandbox.skillPackageRoot,
      });

      expect(
        firstRun.records.some((record) => record.action === "installed"),
      ).toBe(true);

      const skillPath = join(
        sandbox.openclawDir,
        "workspace",
        "skills",
        "clawdentity-openclaw-relay",
        "SKILL.md",
      );
      const workspaceRelayPath = join(
        sandbox.openclawDir,
        "workspace",
        "skills",
        "clawdentity-openclaw-relay",
        "relay-to-peer.mjs",
      );
      const hooksRelayPath = join(
        sandbox.openclawDir,
        "hooks",
        "transforms",
        "relay-to-peer.mjs",
      );
      const referencePath = join(
        sandbox.openclawDir,
        "workspace",
        "skills",
        "clawdentity-openclaw-relay",
        "references",
        "clawdentity-protocol.md",
      );

      expect(readFileSync(skillPath, "utf8")).toContain("Clawdentity");
      expect(readFileSync(workspaceRelayPath, "utf8")).toContain("relayToPeer");
      expect(readFileSync(hooksRelayPath, "utf8")).toContain("relayToPeer");
      expect(readFileSync(referencePath, "utf8")).toContain("Protocol");

      const secondRun = await installOpenclawSkillArtifacts({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        skillPackageRoot: sandbox.skillPackageRoot,
      });

      expect(
        secondRun.records.every((record) => record.action === "unchanged"),
      ).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  });

  it("reports updated artifacts when source content changes", async () => {
    const sandbox = createSkillSandbox();

    try {
      await installOpenclawSkillArtifacts({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        skillPackageRoot: sandbox.skillPackageRoot,
      });

      writeFileSync(
        join(sandbox.referencesRoot, "clawdentity-protocol.md"),
        "Protocol reference v2\n",
        "utf8",
      );

      const rerun = await installOpenclawSkillArtifacts({
        homeDir: sandbox.homeDir,
        openclawDir: sandbox.openclawDir,
        skillPackageRoot: sandbox.skillPackageRoot,
      });

      expect(rerun.records.some((record) => record.action === "updated")).toBe(
        true,
      );
    } finally {
      sandbox.cleanup();
    }
  });

  it("fails with actionable error when required artifact is missing", async () => {
    const sandbox = createSkillSandbox();
    rmSync(join(sandbox.skillPackageRoot, "dist", "relay-to-peer.mjs"), {
      force: true,
    });

    try {
      await expect(
        installOpenclawSkillArtifacts({
          homeDir: sandbox.homeDir,
          openclawDir: sandbox.openclawDir,
          skillPackageRoot: sandbox.skillPackageRoot,
        }),
      ).rejects.toMatchObject({
        code: "CLI_SKILL_ARTIFACT_MISSING",
      } satisfies Partial<SkillInstallError>);
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("runNpmSkillInstall", () => {
  it("skips install when --skill is not set", async () => {
    const result = await runNpmSkillInstall({
      env: {},
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(result.skipped).toBe(true);
  });

  it("installs bundled skill artifacts when --skill is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "clawdentity-skill-bundle-"));
    const openclawDir = join(root, ".openclaw");
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const result = await runNpmSkillInstall({
        env: { npm_config_skill: "true" },
        homeDir: root,
        openclawDir,
        writeStdout: (line) => stdout.push(line),
        writeStderr: (line) => stderr.push(line),
      });

      expect(result.skipped).toBe(false);
      expect(stderr).toHaveLength(0);
      expect(stdout.some((line) => line.includes("skill install mode"))).toBe(
        true,
      );

      const skillPath = join(
        openclawDir,
        "workspace",
        "skills",
        "clawdentity-openclaw-relay",
        "SKILL.md",
      );
      const hooksRelayPath = join(
        openclawDir,
        "hooks",
        "transforms",
        "relay-to-peer.mjs",
      );

      expect(readFileSync(skillPath, "utf8")).toContain("OpenClaw Relay");
      expect(readFileSync(hooksRelayPath, "utf8")).toContain("relay-to-peer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
