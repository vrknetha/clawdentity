import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPath,
  buildErrnoError,
  cleanupAgentTestGlobals,
  createJsonResponse,
  DEFAULT_AGENT_DID,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  mockedReadFile,
  mockedResolveConfig,
  mockFetch,
  resetAgentTestMocks,
  runAgentCommand,
  setupRevokeDefaults,
  stubAgentFetch,
} from "./helpers.js";

describe("agent revoke command", () => {
  beforeEach(() => {
    resetAgentTestMocks();
    stubAgentFetch();
    setupRevokeDefaults();
  });

  afterEach(() => {
    cleanupAgentTestGlobals();
  });

  it("revokes agent by local name and prints confirmation", async () => {
    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(mockedReadFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "identity.json"),
      "utf-8",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      `https://registry.clawdentity.com/v1/agents/${DEFAULT_AGENT_ID}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
        }),
      }),
    );

    expect(result.stdout).toContain(
      `Agent revoked: ${DEFAULT_AGENT_NAME} (${DEFAULT_AGENT_DID})`,
    );
    expect(result.stdout).toContain(
      "CRL visibility depends on verifier refresh interval.",
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("treats repeat revoke as success (idempotent 204)", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(204, {
        ok: true,
      }),
    );

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stdout).toContain(`Agent revoked: ${DEFAULT_AGENT_NAME}`);
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when API key is missing", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "https://registry.clawdentity.com",
    });

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("API key is not configured");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when local identity.json does not exist", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("identity.json");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when identity.json is invalid JSON", async () => {
    mockedReadFile.mockResolvedValueOnce("{ did:");

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("identity.json");
    expect(result.stderr).toContain("valid JSON");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when identity did is invalid", async () => {
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        did: "invalid-did",
      }),
    );

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("invalid did");
    expect(result.stderr).toContain("identity.json");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles registry 401 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(401, {
        error: {
          message: "Invalid API key",
        },
      }),
    );

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("authentication failed");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry 404 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(404, {
        error: {
          message: "Agent not found",
        },
      }),
    );

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("Agent not found");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry 409 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(409, {
        error: {
          message: "Agent cannot be revoked",
        },
      }),
    );

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("cannot be revoked");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry connection errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await runAgentCommand(["revoke", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("Unable to connect to the registry");
    expect(result.exitCode).toBe(1);
  });

  it("rejects dot-segment agent names before resolving identity path", async () => {
    const result = await runAgentCommand(["revoke", ".."]);

    expect(result.stderr).toContain('Agent name must not be "." or "..".');
    expect(result.exitCode).toBe(1);
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
