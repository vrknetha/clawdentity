import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/manager.js", () => ({
  resolveConfig: vi.fn(),
}));

import { resolveConfig } from "../config/manager.js";
import {
  createApiKey,
  createApiKeyCommand,
  listApiKeys,
  revokeApiKey,
} from "./api-key.js";

const mockedResolveConfig = vi.mocked(resolveConfig);

const mockFetch = vi.fn<typeof fetch>();

const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

async function runApiKeyCommand(args: string[]) {
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

  const command = createApiKeyCommand({
    fetchImpl: mockFetch as unknown as typeof fetch,
    resolveConfigImpl: async () => ({
      registryUrl: "https://registry.clawdentity.com",
      apiKey: "clw_pat_local",
    }),
  });
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "api-key", ...args]);
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
}

describe("api-key command helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://registry.clawdentity.com",
      apiKey: "clw_pat_local",
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("creates API key and returns metadata with token", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        apiKey: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZ9",
          name: "workstation",
          status: "active",
          createdAt: "2026-02-16T00:00:00.000Z",
          lastUsedAt: null,
          token: "clw_pat_created",
        },
      }),
    );

    const result = await createApiKey(
      {},
      {
        fetchImpl: mockFetch as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com",
          apiKey: "clw_pat_local",
        }),
      },
    );

    expect(result.apiKey.token).toBe("clw_pat_created");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.clawdentity.com/v1/me/api-keys",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clw_pat_local",
        }),
      }),
    );
  });

  it("lists API key metadata entries", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        apiKeys: [
          {
            id: "01KJ8E2A4F8B10V8R8A6T8XKZ9",
            name: "workstation",
            status: "active",
            createdAt: "2026-02-16T00:00:00.000Z",
            lastUsedAt: "2026-02-16T01:00:00.000Z",
          },
          {
            id: "01KJ8E2A4F8B10V8R8A6T8XKZA",
            name: "old-key",
            status: "revoked",
            createdAt: "2026-02-15T00:00:00.000Z",
            lastUsedAt: null,
          },
        ],
      }),
    );

    const result = await listApiKeys(
      {},
      {
        fetchImpl: mockFetch as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com",
          apiKey: "clw_pat_local",
        }),
      },
    );

    expect(result.apiKeys).toHaveLength(2);
    expect(result.apiKeys[0]?.status).toBe("active");
    expect(result.apiKeys[1]?.status).toBe("revoked");
  });

  it("revokes API key by id", async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse(204, {}));

    const result = await revokeApiKey(
      "01KJ8E2A4F8B10V8R8A6T8XKZ9",
      {},
      {
        fetchImpl: mockFetch as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com",
          apiKey: "clw_pat_local",
        }),
      },
    );

    expect(result.apiKeyId).toBe("01KJ8E2A4F8B10V8R8A6T8XKZ9");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://registry.clawdentity.com/v1/me/api-keys/01KJ8E2A4F8B10V8R8A6T8XKZ9",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer clw_pat_local",
        }),
      }),
    );
  });

  it("fails create when local API key is not configured", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "https://registry.clawdentity.com",
    });

    await expect(
      createApiKey(
        {},
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: mockedResolveConfig,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_API_KEY_MISSING_LOCAL_CREDENTIALS",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails revoke when key id is invalid", async () => {
    await expect(
      revokeApiKey(
        "not-a-ulid",
        {},
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com",
            apiKey: "clw_pat_local",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_API_KEY_ID_INVALID",
      message: "API key id must be a valid ULID",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("maps revoke 404 to stable message", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(404, {
        error: {
          code: "API_KEY_NOT_FOUND",
          message: "API key not found",
        },
      }),
    );

    await expect(
      revokeApiKey(
        "01KJ8E2A4F8B10V8R8A6T8XKZ9",
        {},
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com",
            apiKey: "clw_pat_local",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_API_KEY_REVOKE_FAILED",
      message: "API key (404): API key not found",
    });
  });

  it("sets command exit code and stderr on create failure", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(401, {
        error: {
          code: "API_KEY_INVALID",
          message: "API key is invalid",
        },
      }),
    );

    const result = await runApiKeyCommand(["create"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Registry authentication failed");
  });

  it("prints token once for create command", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        apiKey: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZ9",
          name: "workstation",
          status: "active",
          createdAt: "2026-02-16T00:00:00.000Z",
          lastUsedAt: null,
          token: "clw_pat_created",
        },
      }),
    );

    const result = await runApiKeyCommand(["create", "--name", "workstation"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("API key created");
    expect(result.stdout).toContain("Token (shown once):");
    expect(result.stdout).toContain("clw_pat_created");
  });

  it("prints empty state for list command", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        apiKeys: [],
      }),
    );

    const result = await runApiKeyCommand(["list"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("No API keys found.");
  });

  it("prints revoke success message", async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse(204, {}));

    const result = await runApiKeyCommand([
      "revoke",
      "01KJ8E2A4F8B10V8R8A6T8XKZ9",
    ]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain(
      "API key revoked: 01KJ8E2A4F8B10V8R8A6T8XKZ9",
    );
  });
});
