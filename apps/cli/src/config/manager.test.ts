import { readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

import { resetClawdentityEnv } from "../test-env.js";
import {
  DEFAULT_REGISTRY_URL,
  getCacheDir,
  getCacheFilePath,
  getConfigDir,
  getConfigFilePath,
  getConfigValue,
  readCacheFile,
  readConfig,
  resolveConfig,
  setConfigValue,
  writeCacheFile,
  writeConfig,
} from "./manager.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);
const mockedChmod = vi.mocked(chmod);
const mockedCp = vi.mocked(cp);
const mockedReaddir = vi.mocked(readdir);
const mockedStat = vi.mocked(stat);
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
    mockedReadFileSync.mockImplementation(() => {
      throw buildErrnoError("ENOENT");
    });
    mockedReaddir.mockResolvedValue([]);
    mockedStat.mockRejectedValue(buildErrnoError("ENOENT"));
    process.env = resetClawdentityEnv(previousEnv);
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
    mockedReadFile.mockResolvedValueOnce(
      '{"apiKey":"secret","humanName":"Ravi"}',
    );

    await expect(readConfig()).resolves.toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      apiKey: "secret",
      humanName: "Ravi",
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
      registryUrl: "https://registry.clawdentity.com",
      apiKey: "token",
    });

    expect(mockedMkdir).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod",
      {
        recursive: true,
      },
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod/config.json",
      '{\n  "registryUrl": "https://registry.clawdentity.com",\n  "apiKey": "token"\n}\n',
      "utf-8",
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod/config.json",
      0o600,
    );
  });

  it("routes writes to dev state when registryUrl points to dev", async () => {
    await writeConfig({
      registryUrl: "https://dev.registry.clawdentity.com",
      apiKey: "token",
    });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/dev/config.json",
      '{\n  "registryUrl": "https://dev.registry.clawdentity.com",\n  "apiKey": "token"\n}\n',
      "utf-8",
    );
  });

  it("routes writes to local state when registryUrl points to local host", async () => {
    await writeConfig({
      registryUrl: "http://127.0.0.1:8788",
      apiKey: "token",
    });

    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/local/config.json",
      '{\n  "registryUrl": "http://127.0.0.1:8788",\n  "apiKey": "token"\n}\n',
      "utf-8",
    );
  });

  it("applies env override over file config", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY_URL = "http://env:8787";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: "http://env:8787",
    });
  });

  it("applies CLAWDENTITY_REGISTRY when CLAWDENTITY_REGISTRY_URL is unset", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY = "http://legacy-env:8787";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: "http://legacy-env:8787",
    });
  });

  it("prefers CLAWDENTITY_REGISTRY_URL over CLAWDENTITY_REGISTRY", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY_URL = "http://primary-env:8787";
    process.env.CLAWDENTITY_REGISTRY = "http://legacy-env:8787";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: "http://primary-env:8787",
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

  it("prefers env humanName over config file", async () => {
    mockedReadFile.mockResolvedValueOnce('{"humanName":"from-file"}');
    process.env.CLAWDENTITY_HUMAN_NAME = "from-env";

    await expect(resolveConfig()).resolves.toEqual({
      registryUrl: DEFAULT_REGISTRY_URL,
      humanName: "from-env",
    });
  });

  it("returns a single resolved value", async () => {
    mockedReadFile.mockResolvedValueOnce('{"registryUrl":"http://file:8787"}');
    process.env.CLAWDENTITY_REGISTRY_URL = "http://env:8787";

    await expect(getConfigValue("registryUrl")).resolves.toBe(
      "http://env:8787",
    );
  });

  it("moves config to state mapped by updated registryUrl", async () => {
    mockedReadFile.mockResolvedValueOnce(
      '{"registryUrl":"https://registry.clawdentity.com","apiKey":"token"}',
    );

    await setConfigValue("registryUrl", "https://dev.registry.clawdentity.com");

    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/dev/config.json",
      '{\n  "registryUrl": "https://dev.registry.clawdentity.com",\n  "apiKey": "token"\n}\n',
      "utf-8",
    );
  });

  it("uses prod state by default", () => {
    expect(getConfigDir()).toBe("/mock-home/.clawdentity/states/prod");
    expect(getConfigFilePath()).toBe(
      "/mock-home/.clawdentity/states/prod/config.json",
    );
    expect(getCacheDir()).toBe("/mock-home/.clawdentity/states/prod/cache");
    expect(getCacheFilePath("registry-keys.json")).toBe(
      "/mock-home/.clawdentity/states/prod/cache/registry-keys.json",
    );
  });

  it("selects dev state from env registry URL", () => {
    process.env.CLAWDENTITY_REGISTRY_URL =
      "https://dev.registry.clawdentity.com";

    expect(getConfigDir()).toBe("/mock-home/.clawdentity/states/dev");
  });

  it("selects local state from env registry URL", () => {
    process.env.CLAWDENTITY_REGISTRY_URL = "http://host.docker.internal:8788";

    expect(getConfigDir()).toBe("/mock-home/.clawdentity/states/local");
  });

  it("selects state from router hint when env is unset", () => {
    mockedReadFileSync.mockReturnValueOnce(
      '{"lastRegistryUrl":"https://dev.registry.clawdentity.com","lastState":"dev"}\n',
    );

    expect(getConfigDir()).toBe("/mock-home/.clawdentity/states/dev");
  });

  it("migrates legacy root entries to prod state", async () => {
    mockedReaddir.mockResolvedValueOnce([{ name: "agents" }] as never);
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    await readConfig();

    expect(mockedCp).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/agents",
      "/mock-home/.clawdentity/states/prod/agents",
      {
        recursive: true,
        errorOnExist: false,
      },
    );
  });

  it("returns undefined when cache file does not exist", async () => {
    mockedReadFile.mockRejectedValueOnce(buildErrnoError("ENOENT"));

    await expect(readCacheFile("registry-keys.json")).resolves.toBeUndefined();
  });

  it("reads cache file contents", async () => {
    mockedReadFile.mockResolvedValueOnce("cached-value");

    await expect(readCacheFile("crl-claims.json")).resolves.toBe(
      "cached-value",
    );
  });

  it("writes cache file and secures file permissions", async () => {
    await writeCacheFile("registry-keys.json", '{\n  "ok": true\n}\n');

    expect(mockedMkdir).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod/cache",
      {
        recursive: true,
      },
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod/cache/registry-keys.json",
      '{\n  "ok": true\n}\n',
      "utf-8",
    );
    expect(mockedChmod).toHaveBeenCalledWith(
      "/mock-home/.clawdentity/states/prod/cache/registry-keys.json",
      0o600,
    );
  });
});
