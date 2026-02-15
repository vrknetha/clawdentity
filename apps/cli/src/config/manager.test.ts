import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import {
  DEFAULT_REGISTRY_URL,
  getConfigDir,
  getConfigFilePath,
  getConfigValue,
  readConfig,
  resolveConfig,
  setConfigValue,
  writeConfig,
} from "./manager.js";

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);
const mockedChmod = vi.mocked(chmod);
const mockedHomedir = vi.mocked(homedir);

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe("config manager", () => {
  const previousEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedHomedir.mockReturnValue("/mock-home");
    process.env = { ...previousEnv };
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it("returns defaults when config does not exist", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    await expect(readConfig()).resolves.toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
    });
  });

  it("merges file contents with defaults", async () => {
    mockedReadFile.mockResolvedValueOnce('{"apiKey":"secret"}');

    await expect(readConfig()).resolves.toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      apiKey: "secret",
    });
  });

  it("rethrows non-ENOENT read failures", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("EACCES"));

    await expect(readConfig()).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("writes config and secures file permissions", async () => {
    await writeConfig({
      registryUrl: "http://localhost:8787",
      apiKey: "token",
    });

    expect(mockedMkdir).toHaveBeenCalledWith("/mock-home/.clawdentity", {
      recursive: true,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/config.json",
      '{\n  "registryUrl": "http://localhost:8787",\n  "apiKey": "token"\n}\n',
      "utf-8",
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/config.json",
      0o600,
    );
  });

  it("applies env override over file config", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY_URL = "http://env:8787";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: "http://env:8787",
    });
  });

  it("prefers env apiKey over config file", async () => {
    mockedReadFile.mockResolvedValueOnce('{"apiKey":"from-file"}');
    process.env.CLAWDENTITY_API_KEY = "from-env";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      apiKey: "from-env",
    });
  });

  it("returns a single resolved value", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY_URL = "http://env:8787";

    await expect(getConfigValue("registryUrl")).resolves.toBe(
      "http://env:8787",
    );
  });

  it("reads, merges, and writes when setting values", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');

    await setConfigValue("apiKey", "new-token");

    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/config.json",
      '{\n  "registryUrl": "http://file:8787",\n  "apiKey": "new-token"\n}\n',
      "utf-8",
    );
  });

  it("exposes config location helpers", () => {
    expect(getConfigDir()).toBe("/mock-home/.clawdentity");
    expect(getConfigFilePath()).toBe("/mock-home/.clawdentity/config.json");
  });
});
