import { INVITES_PATH, INVITES_REDEEM_PATH } from "@clawdentity/protocol";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { setConfigValue } from "../config/manager.js";
import {
  createInvite,
  createInviteCommand,
  persistRedeemConfig,
  redeemInvite,
} from "./invite.js";

const mockFetch = vi.fn<typeof fetch>();

const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

async function runInviteCommand(
  args: string[],
  input: {
    fetchImpl?: typeof fetch;
    resolveConfigImpl?: () => Promise<{
      registryUrl: string;
      apiKey?: string;
      humanName?: string;
    }>;
    setConfigValueImpl?: typeof setConfigValue;
  } = {},
) {
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

  const command = createInviteCommand({
    fetchImpl: input.fetchImpl ?? (mockFetch as unknown as typeof fetch),
    resolveConfigImpl:
      input.resolveConfigImpl ??
      (async () => ({
        registryUrl: "https://api.clawdentity.com",
        apiKey: "clw_pat_local",
      })),
    setConfigValueImpl: input.setConfigValueImpl,
  });
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "invite", ...args]);
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

describe("invite command helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("creates invite with PAT auth", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        invite: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZ9",
          code: "clw_invite_123",
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: null,
        },
      }),
    );

    const result = await createInvite(
      {
        expiresAt: "2026-02-20T00:00:00.000Z",
      },
      {
        fetchImpl: mockFetch as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.clawdentity.com",
          apiKey: "clw_pat_admin",
        }),
      },
    );

    expect(result.invite.code).toBe("clw_invite_123");
    expect(result.registryUrl).toBe("https://api.clawdentity.com/");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(`https://api.clawdentity.com${INVITES_PATH}`);
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>).authorization).toBe(
      "Bearer clw_pat_admin",
    );
    expect(JSON.parse(String(calledInit.body))).toEqual({
      expiresAt: "2026-02-20T00:00:00.000Z",
    });
  });

  it("fails invite create when local API key is missing", async () => {
    await expect(
      createInvite(
        {},
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://api.clawdentity.com",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_INVITE_MISSING_LOCAL_CREDENTIALS",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("redeems invite and returns PAT payload", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        apiKey: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZA",
          name: "invite-issued",
          token: "clw_pat_invite_token",
        },
        human: {
          displayName: "Invitee Alpha",
        },
        proxyUrl: "https://proxy.clawdentity.com",
      }),
    );

    const result = await redeemInvite(
      "clw_invite_123",
      { displayName: "Invitee Alpha" },
      {
        fetchImpl: mockFetch as unknown as typeof fetch,
        resolveConfigImpl: async () => ({
          registryUrl: "https://api.clawdentity.com",
        }),
      },
    );

    expect(result.apiKeyToken).toBe("clw_pat_invite_token");
    expect(result.apiKeyName).toBe("invite-issued");
    expect(result.humanName).toBe("Invitee Alpha");
    expect(result.proxyUrl).toBe("https://proxy.clawdentity.com/");
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(`https://api.clawdentity.com${INVITES_REDEEM_PATH}`);
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>).authorization).toBe(
      undefined,
    );
    expect(JSON.parse(String(calledInit.body))).toEqual({
      code: "clw_invite_123",
      displayName: "Invitee Alpha",
      apiKeyName: undefined,
    });
  });

  it("maps invalid invite redeem response", async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse(201, { apiKey: {} }));

    await expect(
      redeemInvite(
        "clw_invite_123",
        { displayName: "Invitee Alpha" },
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://api.clawdentity.com",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_INVITE_REDEEM_INVALID_RESPONSE",
      message: "Invite redeem response is invalid",
    });
  });

  it("requires display name for invite redeem", async () => {
    await expect(
      redeemInvite(
        "clw_invite_123",
        {},
        {
          fetchImpl: mockFetch as unknown as typeof fetch,
          resolveConfigImpl: async () => ({
            registryUrl: "https://api.clawdentity.com",
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_INVITE_REDEEM_DISPLAY_NAME_REQUIRED",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("persist redeem config", () => {
  it("saves registry url, api key, and proxy url sequentially", async () => {
    const setConfigValueMock = vi.fn(async () => {});

    await persistRedeemConfig(
      "https://api.clawdentity.com/",
      "token",
      "https://proxy.clawdentity.com/",
      "Invitee Alpha",
      {
        setConfigValueImpl: setConfigValueMock,
      },
    );

    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      1,
      "registryUrl",
      "https://api.clawdentity.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(2, "apiKey", "token");
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      3,
      "proxyUrl",
      "https://proxy.clawdentity.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      4,
      "humanName",
      "Invitee Alpha",
    );
  });

  it("throws CLI error when config persistence fails", async () => {
    const setConfigValueMock = vi.fn(async () => {
      throw new Error("disk-full");
    });

    await expect(
      persistRedeemConfig(
        "https://api.clawdentity.com/",
        "token",
        "https://proxy.clawdentity.com/",
        "Invitee Alpha",
        {
          setConfigValueImpl: setConfigValueMock,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_INVITE_REDEEM_CONFIG_PERSISTENCE_FAILED",
      message: "Failed to save redeemed API key locally",
    });
  });
});

describe("invite command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("prints invite create output", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        invite: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZ9",
          code: "clw_invite_123",
          expiresAt: null,
        },
      }),
    );

    const result = await runInviteCommand(["create"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Invite created");
    expect(result.stdout).toContain("Code: clw_invite_123");
    expect(result.stdout).toContain("Expires At: never");
  });

  it("prints token once and saves config for redeem", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(201, {
        apiKey: {
          id: "01KJ8E2A4F8B10V8R8A6T8XKZA",
          name: "invite-issued",
          token: "clw_pat_invite_token",
        },
        human: {
          displayName: "Invitee Alpha",
        },
        proxyUrl: "https://proxy.clawdentity.com",
      }),
    );
    const setConfigValueMock = vi.fn(async () => {});

    const result = await runInviteCommand(
      ["redeem", "clw_invite_123", "--display-name", "Invitee Alpha"],
      {
        setConfigValueImpl: setConfigValueMock,
      },
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Invite redeemed");
    expect(result.stdout).toContain("Human name: Invitee Alpha");
    expect(result.stdout).toContain("API key token (shown once):");
    expect(result.stdout).toContain("clw_pat_invite_token");
    expect(result.stdout).toContain("API key saved to local config");
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      1,
      "registryUrl",
      "https://api.clawdentity.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      2,
      "apiKey",
      "clw_pat_invite_token",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      3,
      "proxyUrl",
      "https://proxy.clawdentity.com/",
    );
    expect(setConfigValueMock).toHaveBeenNthCalledWith(
      4,
      "humanName",
      "Invitee Alpha",
    );
  });

  it("sets exit code and stderr on create failure", async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(403, {
        error: {
          code: "ADMIN_ONLY",
          message: "admin role required",
        },
      }),
    );

    const result = await runInviteCommand(["create"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invite creation requires admin access");
  });
});
