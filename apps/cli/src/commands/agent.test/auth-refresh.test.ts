import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPath,
  cleanupAgentTestGlobals,
  DEFAULT_AGENT_NAME,
  mockedRefreshAgentAuthWithClawProof,
  mockedRename,
  mockedWriteFile,
  resetAgentTestMocks,
  runAgentCommand,
  setupAuthRefreshDefaults,
  setupAuthRefreshReadFiles,
  stubAgentFetch,
} from "./helpers.js";

describe("agent auth refresh command", () => {
  beforeEach(() => {
    resetAgentTestMocks();
    stubAgentFetch();
    setupAuthRefreshDefaults();
  });

  afterEach(() => {
    cleanupAgentTestGlobals();
  });

  it("refreshes agent auth and rewrites registry-auth.json", async () => {
    const result = await runAgentCommand([
      "auth",
      "refresh",
      DEFAULT_AGENT_NAME,
    ]);

    expect(mockedRefreshAgentAuthWithClawProof).toHaveBeenCalledWith(
      expect.objectContaining({
        registryUrl: "https://registry.clawdentity.com",
        ait: "ait.jwt.value",
        refreshToken: "clw_rft_old_refresh",
      }),
    );
    const [tempPath, tempContents, tempEncoding] = mockedWriteFile.mock
      .calls[0] as [string, string, BufferEncoding];
    expect(tempPath).toContain(
      `${agentPath(DEFAULT_AGENT_NAME, "registry-auth.json")}.tmp-`,
    );
    expect(tempContents).toContain('"refreshToken": "clw_rft_new_refresh"');
    expect(tempEncoding).toBe("utf-8");
    expect(mockedRename).toHaveBeenCalledWith(
      tempPath,
      agentPath(DEFAULT_AGENT_NAME, "registry-auth.json"),
    );
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "registry-auth.json"),
      expect.stringContaining('"refreshToken": "clw_rft_new_refresh"'),
      "utf-8",
    );
    expect(result.stdout).toContain(
      `Agent auth refreshed: ${DEFAULT_AGENT_NAME}`,
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when registry-auth.json is missing", async () => {
    setupAuthRefreshReadFiles({ missingRegistryAuth: true });

    const result = await runAgentCommand([
      "auth",
      "refresh",
      DEFAULT_AGENT_NAME,
    ]);

    expect(result.stderr).toContain("registry-auth.json");
    expect(result.exitCode).toBe(1);
    expect(mockedRefreshAgentAuthWithClawProof).not.toHaveBeenCalled();
  });

  it("passes base-path registry urls through to shared refresh client", async () => {
    setupAuthRefreshReadFiles({
      registryUrl: "https://registry.clawdentity.com/registry",
    });

    await runAgentCommand(["auth", "refresh", DEFAULT_AGENT_NAME]);

    expect(mockedRefreshAgentAuthWithClawProof).toHaveBeenCalledWith(
      expect.objectContaining({
        registryUrl: "https://registry.clawdentity.com/registry",
      }),
    );
  });
});
