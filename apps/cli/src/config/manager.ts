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
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY_URL = "https://registry.clawdentity.com";
const DEFAULT_DEV_REGISTRY_URL = "https://dev.registry.clawdentity.com";
const DEFAULT_LOCAL_REGISTRY_URL = "http://127.0.0.1:8788";

export interface CliConfig {
  registryUrl: string;
  proxyUrl?: string;
  apiKey?: string;
  humanName?: string;
}

export type CliConfigKey = keyof CliConfig;
export type CliStateKind = "prod" | "dev" | "local";

export type ConfigPathOptions = {
  homeDir?: string;
  registryUrlHint?: string;
};

type CliStateRouter = {
  lastRegistryUrl?: string;
  lastState?: CliStateKind;
  migratedLegacyState?: boolean;
};

const CONFIG_ROOT_DIR = ".clawdentity";
const CONFIG_STATES_DIR = "states";
const CONFIG_ROUTER_FILE = "router.json";
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

const STATE_KIND_BY_REGISTRY_HOST: Record<string, CliStateKind> = {
  "registry.clawdentity.com": "prod",
  "dev.registry.clawdentity.com": "dev",
};

const LOCAL_REGISTRY_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
]);

const LEGACY_ROOT_ENTRIES = new Set([CONFIG_STATES_DIR, CONFIG_ROUTER_FILE]);

const isConfigObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const parseNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

const isCliStateKind = (value: unknown): value is CliStateKind => {
  return value === "prod" || value === "dev" || value === "local";
};

const resolveHomeDir = (options?: ConfigPathOptions): string => {
  const configured = parseNonEmptyString(options?.homeDir);
  return configured ?? homedir();
};

const getConfigRootDir = (options?: ConfigPathOptions): string => {
  return join(resolveHomeDir(options), CONFIG_ROOT_DIR);
};

const getConfigStatesDir = (options?: ConfigPathOptions): string => {
  return join(getConfigRootDir(options), CONFIG_STATES_DIR);
};

const getRouterFilePath = (options?: ConfigPathOptions): string => {
  return join(getConfigRootDir(options), CONFIG_ROUTER_FILE);
};

const readRouterSync = (options?: ConfigPathOptions): CliStateRouter => {
  try {
    const raw = readFileSync(getRouterFilePath(options), "utf-8");
    const parsed = JSON.parse(raw);
    if (!isConfigObject(parsed)) {
      return {};
    }

    const lastRegistryUrl = parseNonEmptyString(parsed.lastRegistryUrl);
    const lastState = isCliStateKind(parsed.lastState)
      ? parsed.lastState
      : undefined;
    const migratedLegacyState = parsed.migratedLegacyState === true;

    return {
      lastRegistryUrl,
      lastState,
      migratedLegacyState,
    };
  } catch {
    return {};
  }
};

const getRegistryUrlOverrideFromEnv = (): string | undefined => {
  const envCandidates = [
    process.env.CLAWDENTITY_REGISTRY_URL,
    process.env.CLAWDENTITY_REGISTRY,
  ];

  return envCandidates.find((value): value is string => {
    return typeof value === "string" && value.trim().length > 0;
  });
};

const resolveStateKindFromRegistryUrl = (registryUrl: string): CliStateKind => {
  try {
    const host = new URL(registryUrl).hostname.trim().toLowerCase();
    const mapped = STATE_KIND_BY_REGISTRY_HOST[host];
    if (mapped) {
      return mapped;
    }

    if (LOCAL_REGISTRY_HOSTS.has(host)) {
      return "local";
    }

    return "prod";
  } catch {
    return "prod";
  }
};

const defaultRegistryUrlForState = (state: CliStateKind): string => {
  switch (state) {
    case "dev":
      return DEFAULT_DEV_REGISTRY_URL;
    case "local":
      return DEFAULT_LOCAL_REGISTRY_URL;
    default:
      return DEFAULT_REGISTRY_URL;
  }
};

const resolveStateSelection = (
  options?: ConfigPathOptions,
): {
  stateKind: CliStateKind;
  registryUrl: string;
} => {
  const hintedRegistryUrl = parseNonEmptyString(options?.registryUrlHint);
  if (hintedRegistryUrl) {
    return {
      stateKind: resolveStateKindFromRegistryUrl(hintedRegistryUrl),
      registryUrl: hintedRegistryUrl,
    };
  }

  const envRegistryUrl = getRegistryUrlOverrideFromEnv();
  if (envRegistryUrl) {
    return {
      stateKind: resolveStateKindFromRegistryUrl(envRegistryUrl),
      registryUrl: envRegistryUrl,
    };
  }

  const router = readRouterSync(options);
  if (router.lastRegistryUrl) {
    return {
      stateKind: resolveStateKindFromRegistryUrl(router.lastRegistryUrl),
      registryUrl: router.lastRegistryUrl,
    };
  }

  if (router.lastState) {
    return {
      stateKind: router.lastState,
      registryUrl: defaultRegistryUrlForState(router.lastState),
    };
  }

  return {
    stateKind: "prod",
    registryUrl: DEFAULT_REGISTRY_URL,
  };
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const writeSecureFile = async (filePath: string, value: string) => {
  const targetDirectory = dirname(filePath);
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(filePath, value, "utf-8");
  await chmod(filePath, FILE_MODE);
};

const writeRouter = async (
  router: CliStateRouter,
  options?: ConfigPathOptions,
): Promise<void> => {
  const payload: CliStateRouter = {};
  if (router.lastRegistryUrl) {
    payload.lastRegistryUrl = router.lastRegistryUrl;
  }
  if (router.lastState) {
    payload.lastState = router.lastState;
  }
  if (router.migratedLegacyState === true) {
    payload.migratedLegacyState = true;
  }

  await writeSecureFile(
    getRouterFilePath(options),
    `${JSON.stringify(payload)}\n`,
  );
};

const ensureStateLayoutMigrated = async (
  options?: ConfigPathOptions,
): Promise<void> => {
  const router = readRouterSync(options);
  if (router.migratedLegacyState === true) {
    return;
  }

  let entries: { name: string }[];
  try {
    entries = await readdir(getConfigRootDir(options), {
      withFileTypes: true,
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const legacyEntries = entries.filter((entry) => {
    return !LEGACY_ROOT_ENTRIES.has(entry.name);
  });

  if (legacyEntries.length > 0) {
    const prodStateDir = join(getConfigStatesDir(options), "prod");
    await mkdir(prodStateDir, { recursive: true });

    for (const entry of legacyEntries) {
      const sourcePath = join(getConfigRootDir(options), entry.name);
      const targetPath = join(prodStateDir, entry.name);
      if (await pathExists(targetPath)) {
        continue;
      }

      await cp(sourcePath, targetPath, {
        recursive: true,
        errorOnExist: false,
      });
    }
  }

  await writeRouter(
    {
      lastRegistryUrl: router.lastRegistryUrl ?? DEFAULT_REGISTRY_URL,
      lastState: router.lastState ?? "prod",
      migratedLegacyState: true,
    },
    options,
  );
};

export const getConfigDir = (options?: ConfigPathOptions): string => {
  const selection = resolveStateSelection(options);
  return join(getConfigStatesDir(options), selection.stateKind);
};

export const getConfigFilePath = (options?: ConfigPathOptions): string =>
  join(getConfigDir(options), CONFIG_FILE);

export const getCacheDir = (options?: ConfigPathOptions): string =>
  join(getConfigDir(options), CACHE_DIR);

export const getCacheFilePath = (
  fileName: string,
  options?: ConfigPathOptions,
): string => join(getCacheDir(options), fileName);

export const readConfig = async (): Promise<CliConfig> => {
  await ensureStateLayoutMigrated();

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
  await ensureStateLayoutMigrated();

  const selection = resolveStateSelection({
    registryUrlHint: config.registryUrl,
  });
  await writeSecureFile(
    getConfigFilePath({ registryUrlHint: config.registryUrl }),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  const currentRouter = readRouterSync();
  await writeRouter({
    lastRegistryUrl: selection.registryUrl,
    lastState: selection.stateKind,
    migratedLegacyState: currentRouter.migratedLegacyState === true,
  });
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
  await ensureStateLayoutMigrated();

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
  await ensureStateLayoutMigrated();
  await writeSecureFile(getCacheFilePath(fileName), value);
};
