import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../config/manager.js", () => ({
  getConfigDir: vi.fn(() => "/mock-home/.clawdentity"),
  resolveConfig: vi.fn(),
}));

vi.mock("@clawdentity/sdk", () => ({
  createLogger: vi.fn(() => ({
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  decodeAIT: vi.fn(),
  encodeEd25519KeypairBase64url: vi.fn(),
  generateEd25519Keypair: vi.fn(),
}));

import {
  type DecodedAit,
  decodeAIT,
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { resolveConfig } from "../config/manager.js";
import { createAgentCommand } from "./agent.js";

const mockedAccess = vi.mocked(access);
const mockedChmod = vi.mocked(chmod);
const mockedMkdir = vi.mocked(mkdir);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGenerateEd25519Keypair = vi.mocked(generateEd25519Keypair);
const mockedEncodeEd25519KeypairBase64url = vi.mocked(
  encodeEd25519KeypairBase64url,
);
const mockedDecodeAIT = vi.mocked(decodeAIT);

const mockFetch = vi.fn<typeof fetch>();

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

const runAgentCommand = async (args: string[]) => {
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

  const command = createAgentCommand();
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "agent", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
};

describe("agent create command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);

    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
      apiKey: "pat_123",
    });

    mockedAccess.mockRejectedValue(buildErrnoError("ENOENT"));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedChmod.mockResolvedValue(undefined);

    mockedGenerateEd25519Keypair.mockResolvedValue({
      publicKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      secretKey: Uint8Array.from({ length: 32 }, (_, index) => 64 - index),
    });

    mockedEncodeEd25519KeypairBase64url.mockReturnValue({
      publicKey: "public-key-b64url",
      secretKey: "secret-key-b64url",
    });

    mockFetch.mockResolvedValue(
      createJsonResponse(201, {
        agent: {
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          name: "agent-01",
          framework: "openclaw",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        ait: "ait.jwt.value",
      }),
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it("creates an agent identity and writes all files", async () => {
    const result = await runAgentCommand(["create", "agent-01"]);

    expect(mockedGenerateEd25519Keypair).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.clawdentity.com/v1/agents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
          "content-type": "application/json",
        }),
      }),
    );

    expect(mockedWriteFile).toHaveBeenCalledTimes(4);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/secret.key",
      "secret-key-b64url",
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/public.key",
      "public-key-b64url",
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/identity.json",
      expect.stringContaining(
        '"did": "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4"',
      ),
      "utf-8",
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/ait.jwt",
      "ait.jwt.value",
      "utf-8",
    );

    expect(result.stdout).toContain(
      "Agent DID: did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
    );
    expect(result.stdout).toContain("Expires At: 2030-01-01T00:00:00.000Z");
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when API key is missing", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "https://api.clawdentity.com",
    });

    const result = await runAgentCommand(["create", "agent-01"]);

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

    const result = await runAgentCommand(["create", "agent-01"]);

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

    const result = await runAgentCommand(["create", "agent-01"]);

    expect(result.stderr).toContain("rejected the request");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry connection errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await runAgentCommand(["create", "agent-01"]);

    expect(result.stderr).toContain("Unable to connect to the registry");
    expect(result.exitCode).toBe(1);
  });

  it("fails when agent directory already exists", async () => {
    mockedAccess.mockResolvedValueOnce(undefined);

    const result = await runAgentCommand(["create", "agent-01"]);

    expect(result.stderr).toContain("already exists");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets 0600 permissions on every identity file", async () => {
    await runAgentCommand(["create", "agent-01"]);

    expect(mockedChmod).toHaveBeenCalledTimes(4);
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/secret.key",
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/public.key",
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/identity.json",
      0o600,
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/ait.jwt",
      0o600,
    );
  });

  it("sends optional framework and ttl-days values", async () => {
    await runAgentCommand([
      "create",
      "agent-01",
      "--framework",
      "langgraph",
      "--ttl-days",
      "45",
    ]);

    const request = mockFetch.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(request[1]?.body)) as {
      framework?: string;
      ttlDays?: number;
    };

    expect(requestBody.framework).toBe("langgraph");
    expect(requestBody.ttlDays).toBe(45);
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

describe("agent revoke command", () => {
  const agentDid = "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4";
  const agentId = "01HF7YAT00W6W7CM7N3W5FDXT4";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);

    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
      apiKey: "pat_123",
    });

    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        did: agentDid,
      }),
    );

    mockFetch.mockResolvedValue(
      createJsonResponse(204, {
        ok: true,
      }),
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it("revokes agent by local name and prints confirmation", async () => {
    const result = await runAgentCommand(["revoke", "agent-01"]);

    expect(mockedReadFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/identity.json",
      "utf-8",
    );
    expect(mockFetch).toHaveBeenCalledWith(
      `https://api.clawdentity.com/v1/agents/${agentId}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
        }),
      }),
    );

    expect(result.stdout).toContain(`Agent revoked: agent-01 (${agentDid})`);
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

    const result = await runAgentCommand(["revoke", "agent-01"]);

    expect(result.stdout).toContain("Agent revoked: agent-01");
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when API key is missing", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "https://api.clawdentity.com",
    });

    const result = await runAgentCommand(["revoke", "agent-01"]);

    expect(result.stderr).toContain("API key is not configured");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when local identity.json does not exist", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    const result = await runAgentCommand(["revoke", "agent-01"]);

    expect(result.stderr).toContain("not found");
    expect(result.stderr).toContain("identity.json");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails when identity.json is invalid JSON", async () => {
    mockedReadFile.mockResolvedValueOnce("{ did:");

    const result = await runAgentCommand(["revoke", "agent-01"]);

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

    const result = await runAgentCommand(["revoke", "agent-01"]);

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

    const result = await runAgentCommand(["revoke", "agent-01"]);

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

    const result = await runAgentCommand(["revoke", "agent-01"]);

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

    const result = await runAgentCommand(["revoke", "agent-01"]);

    expect(result.stderr).toContain("cannot be revoked");
    expect(result.exitCode).toBe(1);
  });

  it("handles registry connection errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await runAgentCommand(["revoke", "agent-01"]);

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

describe("agent inspect command", () => {
  const decodedAit: DecodedAit = {
    header: {
      alg: "EdDSA",
      typ: "AIT",
      kid: "key-01",
    },
    claims: {
      iss: "https://registry.clawdentity.dev",
      sub: "did:claw:agent:abc",
      ownerDid: "did:claw:human:def",
      name: "agent-01",
      framework: "openclaw",
      cnf: {
        jwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: "pub-key",
        },
      },
      iat: 1672531100,
      nbf: 1672531100,
      exp: 1672531200,
      jti: "01HF7YAT00W6W7CM7N3W5FDXT4",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadFile.mockResolvedValue("mock-ait-token");
    mockedDecodeAIT.mockReturnValue(decodedAit);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("displays all six decoded AIT fields", async () => {
    const result = await runAgentCommand(["inspect", "agent-01"]);

    expect(result.stdout).toContain("DID: did:claw:agent:abc");
    expect(result.stdout).toContain("Owner: did:claw:human:def");
    expect(result.stdout).toContain("Expires: 2023-01-01T00:00:00.000Z");
    expect(result.stdout).toContain("Key ID: key-01");
    expect(result.stdout).toContain("Public Key: pub-key");
    expect(result.stdout).toContain("Framework: openclaw");
    expect(result.exitCode).toBeUndefined();
  });

  it("reads AIT from the expected local file path", async () => {
    await runAgentCommand(["inspect", "agent-01"]);

    expect(mockedReadFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/ait.jwt",
      "utf-8",
    );
    expect(mockedDecodeAIT).toHaveBeenCalledWith("mock-ait-token");
  });

  it("fails when the AIT file is missing", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    const result = await runAgentCommand(["inspect", "agent-01"]);

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

    const result = await runAgentCommand(["inspect", "agent-01"]);

    expect(result.stderr).toContain("empty");
    expect(result.stderr).toContain("ait.jwt");
    expect(result.exitCode).toBe(1);
  });

  it("fails when AIT decoding fails", async () => {
    mockedDecodeAIT.mockImplementationOnce(() => {
      throw new Error("Invalid AIT payload");
    });

    const result = await runAgentCommand(["inspect", "agent-01"]);

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
      ...decodedAit,
      claims: {
        ...decodedAit.claims,
        exp: 1893456000,
      },
    });

    const result = await runAgentCommand(["inspect", "agent-01"]);

    expect(result.stdout).toContain("Expires: 2030-01-01T00:00:00.000Z");
    expect(result.exitCode).toBeUndefined();
  });
});
