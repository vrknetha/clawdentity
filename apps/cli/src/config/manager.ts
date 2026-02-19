import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY_URL = "https://registry.clawdentity.com";

export interface CliConfig {
  registryUrl: string;
  proxyUrl?: string;
  apiKey?: string;
  humanName?: string;
}

export type CliConfigKey = keyof CliConfig;

const CONFIG_DIR = ".clawdentity";
const CONFIG_FILE = "config.json";
const CACHE_DIR = "cache";
const FILE_MODE = 0o600;

const ENV_KEY_MAP: Record<CliConfigKey, string> = {
  registryUrl: "CLAWDENTITY_REGISTRY_URL",
  proxyUrl: "CLAWDENTITY_PROXY_URL",
  apiKey: "CLAWDENTITY_API_KEY",
  humanName: "CLAWDENTITY_HUMAN_NAME",
};

const LEGACY_ENV_KEY_MAP: Partial<Record<CliConfigKey, string[]>> = {
  registryUrl: ["CLAWDENTITY_REGISTRY"],
};

const DEFAULT_CONFIG: CliConfig = {
  registryUrl: DEFAULT_REGISTRY_URL,
};

const isConfigObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeConfig = (raw: unknown): CliConfig => {
  if (!isConfigObject(raw)) {
    return { ...DEFAULT_CONFIG };
  }

  const config: CliConfig = {
    ...DEFAULT_CONFIG,
  };

  if (typeof raw.registryUrl === "string" && raw.registryUrl.length > 0) {
    config.registryUrl = raw.registryUrl;
  }

  if (typeof raw.proxyUrl === "string" && raw.proxyUrl.length > 0) {
    config.proxyUrl = raw.proxyUrl;
  }

  if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
    config.apiKey = raw.apiKey;
  }

  if (typeof raw.humanName === "string" && raw.humanName.length > 0) {
    config.humanName = raw.humanName;
  }

  return config;
};

export const getConfigDir = (): string => join(homedir(), CONFIG_DIR);

export const getConfigFilePath = (): string =>
  join(getConfigDir(), CONFIG_FILE);

export const getCacheDir = (): string => join(getConfigDir(), CACHE_DIR);

export const getCacheFilePath = (fileName: string): string =>
  join(getCacheDir(), fileName);

const writeSecureFile = async (filePath: string, value: string) => {
  const targetDirectory = dirname(filePath);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(filePath, value, "utf-8");
  await chmod(filePath, FILE_MODE);
};

export const readConfig = async (): Promise<CliConfig> => {
  try {
    const configContents = await readFile(getConfigFilePath(), "utf-8");
    return normalizeConfig(JSON.parse(configContents));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }

    throw error;
  }
};

export const resolveConfig = async (): Promise<CliConfig> => {
  const config = await readConfig();

  for (const key of Object.keys(ENV_KEY_MAP) as CliConfigKey[]) {
    const envKeys = [ENV_KEY_MAP[key], ...(LEGACY_ENV_KEY_MAP[key] ?? [])];
    const envVar = envKeys
      .map((envKey) => process.env[envKey])
      .find((value): value is string => {
        return typeof value === "string" && value.length > 0;
      });

    if (typeof envVar === "string" && envVar.length > 0) {
      config[key] = envVar;
    }
  }

  return config;
};

export const writeConfig = async (config: CliConfig): Promise<void> => {
  await writeSecureFile(
    getConfigFilePath(),
    `${JSON.stringify(config, null, 2)}\n`,
  );
};

export const getConfigValue = async <K extends CliConfigKey>(
  key: K,
): Promise<CliConfig[K]> => {
  const config = await resolveConfig();
  return config[key];
};

export const setConfigValue = async <K extends CliConfigKey>(
  key: K,
  value: CliConfig[K],
): Promise<void> => {
  const currentConfig = await readConfig();

  await writeConfig({
    ...currentConfig,
    [key]: value,
  });
};

export const readCacheFile = async (
  fileName: string,
): Promise<string | undefined> => {
  try {
    return await readFile(getCacheFilePath(fileName), "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

export const writeCacheFile = async (
  fileName: string,
  value: string,
): Promise<void> => {
  await writeSecureFile(getCacheFilePath(fileName), value);
};
