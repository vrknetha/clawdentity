import { access } from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

vi.mock("../config/manager.js", () => ({
  getConfigFilePath: vi.fn(() => "/mock-home/.clawdentity/config.json"),
  getConfigValue: vi.fn(),
  readConfig: vi.fn(),
  resolveConfig: vi.fn(),
  setConfigValue: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("@clawdentity/sdk", () => ({
  createLogger: vi.fn(() => ({
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  getConfigValue,
  readConfig,
  resolveConfig,
  setConfigValue,
  writeConfig,
} from "../config/manager.js";
import { createConfigCommand } from "./config.js";

const mockedAccess = vi.mocked(access);
const mockedReadConfig = vi.mocked(readConfig);
const mockedWriteConfig = vi.mocked(writeConfig);
const mockedSetConfigValue = vi.mocked(setConfigValue);
const mockedGetConfigValue = vi.mocked(getConfigValue);
const mockedResolveConfig = vi.mocked(resolveConfig);

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const runConfigCommand = async (args: string[]) => {
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

  const command = createConfigCommand();

  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "config", ...args]);
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

describe("config command", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockedReadConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
    });
    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("initializes config when missing", async () => {
    mockedAccess.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    const result = await runConfigCommand(["init"]);

    expect(mockedReadConfig).toHaveBeenCalled();
    expect(mockedWriteConfig).toHaveBeenCalledWith({
      registryUrl: "https://api.clawdentity.com",
    });
    expect(result.stdout).toContain(
      "Initialized config at /mock-home/.clawdentity/config.json",
    );
    expect(result.exitCode).toBeUndefined();
  });

  it("skips init when config already exists", async () => {
    mockedAccess.mockResolvedValueOnce(undefined);

    const result = await runConfigCommand(["init"]);

    expect(mockedWriteConfig).not.toHaveBeenCalled();
    expect(result.stdout).toContain(
      "Config already exists at /mock-home/.clawdentity/config.json",
    );
  });

  it("sets registry url", async () => {
    await runConfigCommand(["set", "registryUrl", "http://localhost:8787"]);

    expect(mockedSetConfigValue).toHaveBeenCalledWith(
      "registryUrl",
      "http://localhost:8787",
    );
  });

  it("masks apiKey output when setting", async () => {
    const result = await runConfigCommand(["set", "apiKey", "super-secret"]);

    expect(mockedSetConfigValue).toHaveBeenCalledWith("apiKey", "super-secret");
    expect(result.stdout).toContain("Set apiKey=********");
  });

  it("rejects invalid keys for set", async () => {
    const result = await runConfigCommand(["set", "invalid", "value"]);

    expect(mockedSetConfigValue).not.toHaveBeenCalled();
    expect(result.stderr).toContain("Invalid config key");
    expect(result.exitCode).toBe(1);
  });

  it("returns config values", async () => {
    mockedGetConfigValue.mockResolvedValueOnce("http://localhost:8787");

    const result = await runConfigCommand(["get", "registryUrl"]);

    expect(result.stdout).toContain("http://localhost:8787");
  });

  it("prints not set for missing value", async () => {
    mockedGetConfigValue.mockResolvedValueOnce(undefined);

    const result = await runConfigCommand(["get", "apiKey"]);

    expect(result.stdout).toContain("(not set)");
  });

  it("shows resolved config", async () => {
    mockedResolveConfig.mockResolvedValueOnce({
      registryUrl: "http://localhost:8787",
      apiKey: "super-secret",
    });

    const result = await runConfigCommand(["show"]);

    expect(result.stdout).toContain("http://localhost:8787");
    expect(result.stdout).toContain('"apiKey": "********"');
  });
});
