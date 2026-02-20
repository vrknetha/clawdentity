import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPath,
  buildErrnoError,
  DEFAULT_AGENT_NAME,
  decodedAitFixture,
  mockedDecodeAIT,
  mockedReadFile,
  resetAgentTestMocks,
  resetProcessExitCode,
  runAgentCommand,
  setupInspectDefaults,
} from "./helpers.js";

describe("agent inspect command", () => {
  beforeEach(() => {
    resetAgentTestMocks();
    setupInspectDefaults();
  });

  afterEach(() => {
    resetProcessExitCode();
  });

  it("displays all six decoded AIT fields", async () => {
    const result = await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(result.stdout).toContain("DID: did:claw:agent:abc");
    expect(result.stdout).toContain("Owner: did:claw:human:def");
    expect(result.stdout).toContain("Expires: 2023-01-01T00:00:00.000Z");
    expect(result.stdout).toContain("Key ID: key-01");
    expect(result.stdout).toContain("Public Key: pub-key");
    expect(result.stdout).toContain("Framework: openclaw");
    expect(result.exitCode).toBeUndefined();
  });

  it("reads AIT from the expected local file path", async () => {
    await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(mockedReadFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "ait.jwt"),
      "utf-8",
    );
    expect(mockedDecodeAIT).toHaveBeenCalledWith("mock-ait-token");
  });

  it("fails when the AIT file is missing", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    const result = await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("ait.jwt");
    expect(result.exitCode).toBe(1);
  });

  it("rejects dot-segment agent names before resolving the AIT path", async () => {
    const result = await runAgentCommand(["inspect", ".."]);

    expect(result.stderr).toContain('Agent name must not be "." or "..".');
    expect(result.exitCode).toBe(1);
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it("fails when the AIT file is empty", async () => {
    mockedReadFile.mockResolvedValueOnce("  \n");

    const result = await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("empty");
    expect(result.stderr).toContain("ait.jwt");
    expect(result.exitCode).toBe(1);
  });

  it("fails when AIT decoding fails", async () => {
    mockedDecodeAIT.mockImplementationOnce(() => {
      throw new Error("Invalid AIT payload");
    });

    const result = await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("Invalid AIT payload");
    expect(result.exitCode).toBe(1);
  });

  it("fails on invalid agent names", async () => {
    const result = await runAgentCommand(["inspect", "agent/../../etc"]);

    expect(result.stderr).toContain("invalid characters");
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
  });

  it("formats exp as ISO-8601", async () => {
    mockedDecodeAIT.mockReturnValueOnce({
      ...decodedAitFixture,
      claims: {
        ...decodedAitFixture.claims,
        exp: 1893456000,
      },
    });

    const result = await runAgentCommand(["inspect", DEFAULT_AGENT_NAME]);

    expect(result.stdout).toContain("Expires: 2030-01-01T00:00:00.000Z");
    expect(result.exitCode).toBeUndefined();
  });
});
