import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
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
  encodeEd25519KeypairBase64url: vi.fn(),
  generateEd25519Keypair: vi.fn(),
}));

import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { resolveConfig } from "../config/manager.js";
import { createAgentCommand } from "./agent.js";

const mockedAccess = vi.mocked(access);
const mockedChmod = vi.mocked(chmod);
const mockedMkdir = vi.mocked(mkdir);
const mockedWriteFile = vi.mocked(writeFile);
const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedGenerateEd25519Keypair = vi.mocked(generateEd25519Keypair);
const mockedEncodeEd25519KeypairBase64url = vi.mocked(
  encodeEd25519KeypairBase64url,
);

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
});
