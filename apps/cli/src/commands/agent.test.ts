import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
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
  encodeEd25519SignatureBase64url: vi.fn(),
  encodeEd25519KeypairBase64url: vi.fn(),
  generateEd25519Keypair: vi.fn(),
  signHttpRequest: vi.fn(),
  signEd25519: vi.fn(),
}));

import {
  type DecodedAit,
  decodeAIT,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  signEd25519,
  signHttpRequest,
} from "@clawdentity/sdk";
import { resolveConfig } from "../config/manager.js";
import { createAgentCommand } from "./agent.js";

const mockedAccess = vi.mocked(access);
const mockedChmod = vi.mocked(chmod);
const mockedMkdir = vi.mocked(mkdir);
const mockedReadFile = vi.mocked(readFile);
const mockedRename = vi.mocked(rename);
const mockedUnlink = vi.mocked(unlink);
const mockedWriteFile = vi.mocked(writeFile);
const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGenerateEd25519Keypair = vi.mocked(generateEd25519Keypair);
const mockedSignHttpRequest = vi.mocked(signHttpRequest);
const mockedSignEd25519 = vi.mocked(signEd25519);
const mockedEncodeEd25519SignatureBase64url = vi.mocked(
  encodeEd25519SignatureBase64url,
);
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
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);

    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
      apiKey: "pat_123",
    });

    mockedAccess.mockRejectedValue(buildErrnoError("ENOENT"));
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    mockedRename.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
    mockedChmod.mockResolvedValue(undefined);

    mockedGenerateEd25519Keypair.mockResolvedValue({
      publicKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      secretKey: Uint8Array.from({ length: 32 }, (_, index) => 64 - index),
    });

    mockedEncodeEd25519KeypairBase64url.mockReturnValue({
      publicKey: "public-key-b64url",
      secretKey: "secret-key-b64url",
    });

    mockedSignEd25519.mockResolvedValue(Uint8Array.from([1, 2, 3]));
    mockedSignHttpRequest.mockResolvedValue({
      canonicalRequest: "canonical",
      proof: "proof",
      headers: {
        "X-Claw-Timestamp": "1739364000",
        "X-Claw-Nonce": "nonce-value",
        "X-Claw-Body-SHA256": "body-sha",
        "X-Claw-Proof": "proof",
      },
    });
    mockedEncodeEd25519SignatureBase64url.mockReturnValue(
      "challenge-signature-b64url",
    );

    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/agents/challenge")) {
        return createJsonResponse(201, {
          challengeId: "01JCHALLENGEID1234567890ABC",
          nonce: "challenge-nonce-b64url",
          ownerDid: "did:claw:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
          expiresAt: "2030-01-01T00:05:00.000Z",
        });
      }

      return createJsonResponse(201, {
        agent: {
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          name: "agent-01",
          framework: "openclaw",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
        ait: "ait.jwt.value",
        agentAuth: {
          tokenType: "Bearer",
          accessToken: "clw_agt_access_token",
          accessExpiresAt: "2030-01-01T00:15:00.000Z",
          refreshToken: "clw_rft_refresh_token",
          refreshExpiresAt: "2030-01-31T00:00:00.000Z",
        },
      });
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it("creates an agent identity and writes all files", async () => {
    const result = await runAgentCommand(["create", "agent-01"]);

    expect(mockedGenerateEd25519Keypair).toHaveBeenCalled();
    expect(mockedSignEd25519).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Uint8Array),
    );
    expect(mockedEncodeEd25519SignatureBase64url).toHaveBeenCalledWith(
      Uint8Array.from([1, 2, 3]),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.clawdentity.com/v1/agents/challenge",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer pat_123",
          "content-type": "application/json",
        }),
      }),
    );
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

    expect(mockedWriteFile).toHaveBeenCalledTimes(5);
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
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/registry-auth.json",
      expect.stringContaining('"refreshToken": "clw_rft_refresh_token"'),
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

    expect(mockedChmod).toHaveBeenCalledTimes(5);
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
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/registry-auth.json",
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

describe("agent auth refresh command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    mockedSignHttpRequest.mockResolvedValue({
      canonicalRequest: "canonical",
      proof: "proof",
      headers: {
        "X-Claw-Timestamp": "1739364000",
        "X-Claw-Nonce": "nonce-value",
        "X-Claw-Body-SHA256": "body-sha",
        "X-Claw-Proof": "proof",
      },
    });

    mockedReadFile.mockImplementation(async (path) => {
      const filePath = String(path);
      if (filePath.endsWith("/ait.jwt")) {
        return "ait.jwt.value";
      }
      if (filePath.endsWith("/identity.json")) {
        return JSON.stringify({
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          registryUrl: "https://api.clawdentity.com",
        });
      }
      if (filePath.endsWith("/secret.key")) {
        return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      }
      if (filePath.endsWith("/registry-auth.json")) {
        return JSON.stringify({
          tokenType: "Bearer",
          accessToken: "clw_agt_old_access",
          accessExpiresAt: "2030-01-01T00:15:00.000Z",
          refreshToken: "clw_rft_old_refresh",
          refreshExpiresAt: "2030-01-31T00:00:00.000Z",
        });
      }

      throw buildErrnoError("ENOENT");
    });

    mockFetch.mockResolvedValue(
      createJsonResponse(200, {
        agentAuth: {
          tokenType: "Bearer",
          accessToken: "clw_agt_new_access",
          accessExpiresAt: "2030-01-02T00:15:00.000Z",
          refreshToken: "clw_rft_new_refresh",
          refreshExpiresAt: "2030-02-01T00:00:00.000Z",
        },
      }),
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it("refreshes agent auth and rewrites registry-auth.json", async () => {
    const result = await runAgentCommand(["auth", "refresh", "agent-01"]);

    expect(mockedSignHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        pathWithQuery: "/v1/agents/auth/refresh",
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.clawdentity.com/v1/agents/auth/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Claw ait.jwt.value",
          "content-type": "application/json",
        }),
      }),
    );
    const [tempPath, tempContents, tempEncoding] = mockedWriteFile.mock
      .calls[0] as [string, string, BufferEncoding];
    expect(tempPath).toContain(
      "/mock-home/.clawdentity/agents/agent-01/registry-auth.json.tmp-",
    );
    expect(tempContents).toContain('"refreshToken": "clw_rft_new_refresh"');
    expect(tempEncoding).toBe("utf-8");
    expect(mockedRename).toHaveBeenCalledWith(
      tempPath,
      "/mock-home/.clawdentity/agents/agent-01/registry-auth.json",
    );
    expect(mockedWriteFile).not.toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents/agent-01/registry-auth.json",
      expect.stringContaining('"refreshToken": "clw_rft_new_refresh"'),
      "utf-8",
    );
    expect(result.stdout).toContain("Agent auth refreshed: agent-01");
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when registry-auth.json is missing", async () => {
    mockedReadFile.mockImplementation(async (path) => {
      const filePath = String(path);
      if (filePath.endsWith("/registry-auth.json")) {
        throw buildErrnoError("ENOENT");
      }
      if (filePath.endsWith("/ait.jwt")) {
        return "ait.jwt.value";
      }
      if (filePath.endsWith("/identity.json")) {
        return JSON.stringify({
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          registryUrl: "https://api.clawdentity.com",
        });
      }
      if (filePath.endsWith("/secret.key")) {
        return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      }

      throw buildErrnoError("ENOENT");
    });

    const result = await runAgentCommand(["auth", "refresh", "agent-01"]);

    expect(result.stderr).toContain("registry-auth.json");
    expect(result.exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("signs refresh proof with the resolved endpoint path for base-path registries", async () => {
    mockedReadFile.mockImplementation(async (path) => {
      const filePath = String(path);
      if (filePath.endsWith("/ait.jwt")) {
        return "ait.jwt.value";
      }
      if (filePath.endsWith("/identity.json")) {
        return JSON.stringify({
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          registryUrl: "https://api.clawdentity.com/registry",
        });
      }
      if (filePath.endsWith("/secret.key")) {
        return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      }
      if (filePath.endsWith("/registry-auth.json")) {
        return JSON.stringify({
          tokenType: "Bearer",
          accessToken: "clw_agt_old_access",
          accessExpiresAt: "2030-01-01T00:15:00.000Z",
          refreshToken: "clw_rft_old_refresh",
          refreshExpiresAt: "2030-01-31T00:00:00.000Z",
        });
      }

      throw buildErrnoError("ENOENT");
    });

    await runAgentCommand(["auth", "refresh", "agent-01"]);

    expect(mockedSignHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pathWithQuery: "/registry/v1/agents/auth/refresh",
      }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.clawdentity.com/registry/v1/agents/auth/refresh",
      expect.any(Object),
    );
  });
});

describe("agent revoke command", () => {
  const agentDid = "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4";
  const agentId = "01HF7YAT00W6W7CM7N3W5FDXT4";

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
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
    mockFetch.mockReset();
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
