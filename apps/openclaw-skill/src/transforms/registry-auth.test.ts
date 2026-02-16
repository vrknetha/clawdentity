import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAgentRegistryAuth,
  resolveAgentRegistryAuthPath,
  withAgentRegistryAuthLock,
  writeAgentRegistryAuthAtomic,
} from "./registry-auth.js";

function createSandbox(agentName: string): {
  cleanup: () => void;
  homeDir: string;
} {
  const homeDir = mkdtempSync(
    join(tmpdir(), "clawdentity-openclaw-registry-auth-"),
  );
  mkdirSync(join(homeDir, ".clawdentity", "agents", agentName), {
    recursive: true,
  });

  return {
    cleanup: () => {
      rmSync(homeDir, { recursive: true, force: true });
    },
    homeDir,
  };
}

describe("registry-auth store", () => {
  it("reads an existing registry-auth bundle", async () => {
    const sandbox = createSandbox("alpha-agent");
    const registryAuthPath = resolveAgentRegistryAuthPath({
      homeDir: sandbox.homeDir,
      agentName: "alpha-agent",
    });
    writeFileSync(
      registryAuthPath,
      `${JSON.stringify(
        {
          tokenType: "Bearer",
          accessToken: "clw_agt_access",
          accessExpiresAt: "2030-01-01T00:00:00.000Z",
          refreshToken: "clw_rft_refresh",
          refreshExpiresAt: "2030-02-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    try {
      const auth = await readAgentRegistryAuth({
        homeDir: sandbox.homeDir,
        agentName: "alpha-agent",
      });

      expect(auth.accessToken).toBe("clw_agt_access");
      expect(auth.refreshToken).toBe("clw_rft_refresh");
    } finally {
      sandbox.cleanup();
    }
  });

  it("writes registry-auth atomically with secure permissions", async () => {
    const sandbox = createSandbox("alpha-agent");

    try {
      await writeAgentRegistryAuthAtomic({
        homeDir: sandbox.homeDir,
        agentName: "alpha-agent",
        auth: {
          tokenType: "Bearer",
          accessToken: "clw_agt_new_access",
          accessExpiresAt: "2030-03-01T00:00:00.000Z",
          refreshToken: "clw_rft_new_refresh",
          refreshExpiresAt: "2030-04-01T00:00:00.000Z",
        },
      });

      const registryAuthPath = resolveAgentRegistryAuthPath({
        homeDir: sandbox.homeDir,
        agentName: "alpha-agent",
      });
      const mode = statSync(registryAuthPath).mode & 0o777;
      expect(mode).toBe(0o600);
      const auth = await readAgentRegistryAuth({
        homeDir: sandbox.homeDir,
        agentName: "alpha-agent",
      });
      expect(auth.accessToken).toBe("clw_agt_new_access");
    } finally {
      sandbox.cleanup();
    }
  });

  it("creates and removes lock around operations", async () => {
    const sandbox = createSandbox("alpha-agent");
    const registryAuthPath = resolveAgentRegistryAuthPath({
      homeDir: sandbox.homeDir,
      agentName: "alpha-agent",
    });
    const lockPath = `${registryAuthPath}.lock`;

    try {
      await withAgentRegistryAuthLock({
        homeDir: sandbox.homeDir,
        agentName: "alpha-agent",
        operation: async () => {
          expect(() => statSync(lockPath)).not.toThrow();
          return undefined;
        },
      });

      expect(() => statSync(lockPath)).toThrow();
    } finally {
      sandbox.cleanup();
    }
  });
});
