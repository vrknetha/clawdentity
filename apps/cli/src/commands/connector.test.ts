import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorCommand } from "./connector.js";

function createErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function runConnectorCommand(
  args: string[],
  input: {
    execFileImpl?: (
      file: string,
      args?: readonly string[],
    ) => Promise<{ stderr: string; stdout: string }>;
    getConfigDirImpl?: () => string;
    getHomeDirImpl?: () => string;
    loadConnectorModule?: () => Promise<{
      startConnectorRuntime?: (input: unknown) => Promise<{
        outboundUrl?: string;
        waitUntilStopped?: () => Promise<void>;
        websocketUrl?: string;
      }>;
    }>;
    mkdirImpl?: (
      path: string,
      options?: { recursive?: boolean },
    ) => Promise<void>;
    readFileImpl?: (path: string, encoding: "utf8") => Promise<string>;
    removeFileImpl?: (
      filePath: string,
      options?: { force?: boolean },
    ) => Promise<void>;
    resolveCurrentModulePathImpl?: () => string;
    resolveCurrentPlatformImpl?: () => NodeJS.Platform;
    resolveCurrentUidImpl?: () => number;
    resolveConfigImpl?: () => Promise<{ registryUrl: string }>;
    resolveNodeExecPathImpl?: () => string;
    writeFileImpl?: (
      filePath: string,
      data: string,
      encoding: "utf8",
    ) => Promise<void>;
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

  const command = createConnectorCommand({
    execFileImpl: input.execFileImpl,
    getConfigDirImpl: input.getConfigDirImpl,
    getHomeDirImpl: input.getHomeDirImpl,
    loadConnectorModule: input.loadConnectorModule as
      | (() => Promise<{
          startConnectorRuntime?: (input: unknown) => Promise<{
            outboundUrl?: string;
            waitUntilStopped?: () => Promise<void>;
            websocketUrl?: string;
          }>;
        }>)
      | undefined,
    mkdirImpl: input.mkdirImpl,
    readFileImpl: input.readFileImpl,
    removeFileImpl: input.removeFileImpl,
    resolveCurrentModulePathImpl: input.resolveCurrentModulePathImpl,
    resolveCurrentPlatformImpl: input.resolveCurrentPlatformImpl,
    resolveCurrentUidImpl: input.resolveCurrentUidImpl,
    resolveConfigImpl: input.resolveConfigImpl,
    resolveNodeExecPathImpl: input.resolveNodeExecPathImpl,
    writeFileImpl: input.writeFileImpl,
  });
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "connector", ...args]);
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
}

describe("connector command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("registers connector start command", () => {
    const command = createConnectorCommand();
    expect(command.name()).toBe("connector");
    expect(command.commands.map((item) => item.name())).toContain("start");
    expect(command.commands.map((item) => item.name())).toContain("service");
  });

  it("installs launchd service for connector autostart", async () => {
    const writeFileImpl = vi.fn(
      async (_path: string, _content: string, _encoding: BufferEncoding) => {},
    );
    const mkdirImpl = vi.fn(async (_path: string, _options: unknown) => {});
    const execFileImpl = vi.fn(
      async (_file: string, _args?: readonly string[]) => ({
        stdout: "",
        stderr: "",
      }),
    );

    const result = await runConnectorCommand(
      ["service", "install", "alpha-agent", "--platform", "launchd"],
      {
        execFileImpl,
        getConfigDirImpl: () => "/mock-home/.clawdentity",
        getHomeDirImpl: () => "/mock-home",
        mkdirImpl,
        resolveCurrentModulePathImpl: () =>
          "/mock-cli/dist/commands/connector.js",
        resolveNodeExecPathImpl: () => "/mock-node/bin/node",
        writeFileImpl,
      },
    );

    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    expect(writeFileImpl.mock.calls[0]?.[0]).toBe(
      "/mock-home/Library/LaunchAgents/com.clawdentity.clawdentity-connector-alpha-agent.plist",
    );
    expect(writeFileImpl.mock.calls[0]?.[1]).toContain(
      "<key>ProgramArguments</key>",
    );
    expect(writeFileImpl.mock.calls[0]?.[1]).toContain(
      "<string>/mock-node/bin/node</string>",
    );
    expect(writeFileImpl.mock.calls[0]?.[1]).toContain(
      "<string>/mock-cli/dist/bin.js</string>",
    );
    expect(execFileImpl).toHaveBeenCalledWith("launchctl", [
      "load",
      "-w",
      "/mock-home/Library/LaunchAgents/com.clawdentity.clawdentity-connector-alpha-agent.plist",
    ]);
    expect(result.stdout).toContain(
      "Connector service installed (launchd): com.clawdentity.clawdentity-connector-alpha-agent",
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("uninstalls systemd service for connector autostart", async () => {
    const execFileImpl = vi.fn(
      async (_file: string, _args?: readonly string[]) => ({
        stdout: "",
        stderr: "",
      }),
    );
    const removeFileImpl = vi.fn(
      async (_path: string, _options: unknown) => {},
    );

    const result = await runConnectorCommand(
      ["service", "uninstall", "alpha-agent", "--platform", "systemd"],
      {
        execFileImpl,
        getHomeDirImpl: () => "/mock-home",
        removeFileImpl,
      },
    );

    expect(execFileImpl).toHaveBeenCalledWith("systemctl", [
      "--user",
      "disable",
      "--now",
      "clawdentity-connector-alpha-agent.service",
    ]);
    expect(execFileImpl).toHaveBeenCalledWith("systemctl", [
      "--user",
      "daemon-reload",
    ]);
    expect(removeFileImpl).toHaveBeenCalledWith(
      "/mock-home/.config/systemd/user/clawdentity-connector-alpha-agent.service",
      { force: true },
    );
    expect(result.stdout).toContain(
      "Connector service uninstalled (systemd): clawdentity-connector-alpha-agent",
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("starts connector runtime with local credentials and config", async () => {
    const startConnectorRuntime = vi.fn(async () => ({
      outboundUrl: "http://127.0.0.1:19400/v1/outbound",
      websocketUrl: "wss://proxy.example.com/v1/connector",
      waitUntilStopped: async () => {},
    }));
    const readFileImpl = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith("/ait.jwt")) {
        return "mock.ait.jwt\n";
      }

      if (path.endsWith("/secret.key")) {
        return "mock.secret.key\n";
      }

      if (path.endsWith("/identity.json")) {
        return JSON.stringify({
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
        });
      }

      if (path.endsWith("/registry-auth.json")) {
        return JSON.stringify({
          accessToken: "clw_agt_access",
          refreshToken: "clw_rft_refresh",
        });
      }

      throw createErrnoError("ENOENT");
    });

    const result = await runConnectorCommand(["start", "alpha-agent"], {
      getConfigDirImpl: () => "/mock-home/.clawdentity",
      loadConnectorModule: async () => ({
        startConnectorRuntime,
      }),
      readFileImpl,
      resolveConfigImpl: async () => ({
        registryUrl: "https://api.clawdentity.com",
      }),
    });

    expect(startConnectorRuntime).toHaveBeenCalledTimes(1);
    expect(startConnectorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "alpha-agent",
        configDir: "/mock-home/.clawdentity",
        credentials: {
          accessToken: "clw_agt_access",
          agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          ait: "mock.ait.jwt",
          refreshToken: "clw_rft_refresh",
          secretKey: "mock.secret.key",
        },
        outboundBaseUrl: "http://127.0.0.1:19400",
        outboundPath: "/v1/outbound",
        registryUrl: "https://api.clawdentity.com",
      }),
    );
    expect(result.stdout).toContain(
      'Starting connector runtime for agent "alpha-agent"...',
    );
    expect(result.stdout).toContain(
      "Connector outbound endpoint: http://127.0.0.1:19400/v1/outbound",
    );
    expect(result.stdout).toContain(
      "Connector proxy websocket: wss://proxy.example.com/v1/connector",
    );
    expect(result.stdout).toContain("Connector runtime is active.");
    expect(result.exitCode).toBeUndefined();
  });

  it("fails when required agent credentials are missing", async () => {
    const readFileImpl = vi.fn(async (_path: string): Promise<string> => {
      throw createErrnoError("ENOENT");
    });
    const startConnectorRuntime = vi.fn(async () => ({}));

    const result = await runConnectorCommand(["start", "alpha-agent"], {
      getConfigDirImpl: () => "/mock-home/.clawdentity",
      loadConnectorModule: async () => ({
        startConnectorRuntime,
      }),
      readFileImpl,
      resolveConfigImpl: async () => ({
        registryUrl: "https://api.clawdentity.com",
      }),
    });

    expect(startConnectorRuntime).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Local agent credentials are missing for connector startup",
    );
  });

  it("fails when connector package API is invalid", async () => {
    const readFileImpl = vi.fn(async (path: string): Promise<string> => {
      if (path.endsWith(".json")) {
        return JSON.stringify({
          did: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
          refreshToken: "clw_rft_refresh",
        });
      }

      return "value";
    });

    const result = await runConnectorCommand(["start", "alpha-agent"], {
      getConfigDirImpl: () => "/mock-home/.clawdentity",
      loadConnectorModule: async () => ({}),
      readFileImpl,
      resolveConfigImpl: async () => ({
        registryUrl: "https://api.clawdentity.com",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Connector package does not expose startConnectorRuntime",
    );
  });
});
