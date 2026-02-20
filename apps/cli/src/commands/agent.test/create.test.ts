import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentPath,
  cleanupAgentTestGlobals,
  createJsonResponse,
  DEFAULT_AGENT_DID,
  DEFAULT_AGENT_NAME,
  mockedAccess,
  mockedChmod,
  mockedEncodeEd25519SignatureBase64url,
  mockedGenerateEd25519Keypair,
  mockedMkdir,
  mockedResolveConfig,
  mockedSignEd25519,
  mockedWriteFile,
  mockFetch,
  resetAgentTestMocks,
  runAgentCommand,
  setupCreateCommandDefaults,
  stubAgentFetch,
} from "./helpers.js";

describe("agent create command", () => {
  beforeEach(() => {
    resetAgentTestMocks();
    stubAgentFetch();
    setupCreateCommandDefaults();
  });

  afterEach(() => {
    cleanupAgentTestGlobals();
  });

  it("creates an agent identity and writes all files", async () => {
    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(mockedGenerateEd25519Keypair).toHaveBeenCalled();
    expect(mockedSignEd25519).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Uint8Array),
    );
    expect(mockedEncodeEd25519SignatureBase64url).toHaveBeenCalledWith(
      Uint8Array.from([1, 2, 3]),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.clawdentity.com/v1/agents/challenge",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
          "content-type": "application/json",
        }),
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.clawdentity.com/v1/agents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
          "content-type": "application/json",
        }),
      }),
    );

    expect(mockedWriteFile).toHaveBeenCalledTimes(5);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "secret.key"),
      "secret-key-b64url",
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "public.key"),
      "public-key-b64url",
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "identity.json"),
      expect.stringContaining(`"did": "${DEFAULT_AGENT_DID}"`),
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "ait.jwt"),
      "ait.jwt.value",
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "registry-auth.json"),
      expect.stringContaining('"refreshToken": "clw_rft_refresh_token"'),
      "utf-8",
    );

    expect(result.stdout).toContain(`Agent DID: ${DEFAULT_AGENT_DID}`);
    expect(result.stdout).toContain("Expires At: 2030-01-01T00:00:00.000Z");
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when API key is missing", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "https://registry.clawdentity.com",
    });

    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("API key is not configured");
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

    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("authentication failed");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry 400 responses", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(400, {
        error: {
          message: "name contains invalid characters",
        },
      }),
    );

    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("rejected the request");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry connection errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("Unable to connect to the registry");
    expect(result.exitCode).toBe(1);
  });

  it("fails when agent directory already exists", async () => {
    mockedAccess.mockResolvedValueOnce(undefined);

    const result = await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(result.stderr).toContain("already exists");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets 0600 permissions on every identity file", async () => {
    await runAgentCommand(["create", DEFAULT_AGENT_NAME]);

    expect(mockedChmod).toHaveBeenCalledTimes(5);
    expect(mockedChmod).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "secret.key"),
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "public.key"),
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "identity.json"),
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "ait.jwt"),
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      agentPath(DEFAULT_AGENT_NAME, "registry-auth.json"),
      0o600,
    );
  });

  it("sends optional framework and ttl-days values", async () => {
    await runAgentCommand([
      "create",
      DEFAULT_AGENT_NAME,
      "--framework",
      "langgraph",
      "--ttl-days",
      "45",
    ]);

    const request = mockFetch.mock.calls[1] as [string, RequestInit];
    const requestBody = JSON.parse(String(request[1]?.body)) as {
      framework?: string;
      ttlDays?: number;
      challengeId?: string;
      challengeSignature?: string;
    };

    expect(requestBody.framework).toBe("langgraph");
    expect(requestBody.ttlDays).toBe(45);
    expect(requestBody.challengeId).toBe("01JCHALLENGEID1234567890ABC");
    expect(requestBody.challengeSignature).toBe("challenge-signature-b64url");
  });

  it("rejects dot-segment agent names before hitting the filesystem", async () => {
    const result = await runAgentCommand(["create", "."]);

    expect(result.stderr).toContain('Agent name must not be "." or "..".');
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedMkdir).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
