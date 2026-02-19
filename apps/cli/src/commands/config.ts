import { access } from "node:fs/promises";
import { createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import {
  type CliConfig,
  type CliConfigKey,
  getConfigFilePath,
  getConfigValue,
  readConfig,
  resolveConfig,
  setConfigValue,
  writeConfig,
} from "../config/manager.js";
import {
  fetchRegistryMetadata,
  normalizeRegistryUrl,
} from "../config/registry-metadata.js";
import { writeStderrLine, writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "config" });

const VALID_KEYS = [
  "registryUrl",
  "proxyUrl",
  "apiKey",
  "humanName",
] as const satisfies readonly CliConfigKey[];

const isValidConfigKey = (value: string): value is CliConfigKey => {
  return VALID_KEYS.includes(value as CliConfigKey);
};

const maskApiKey = (config: CliConfig): CliConfig => {
  if (!config.apiKey) {
    return config;
  }

  return {
    ...config,
    apiKey: "********",
  };
};

const isNotFoundError = (error: unknown): boolean => {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === "ENOENT";
};

const getValidatedKey = (key: string): CliConfigKey | undefined => {
  if (isValidConfigKey(key)) {
    return key;
  }

  process.exitCode = 1;
  writeStderrLine(
    `Invalid config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`,
  );
  logger.warn("cli.invalid_config_key", { key });

  return undefined;
};

interface ConfigInitOptions {
  registryUrl?: string;
}

type ConfigCommandDependencies = {
  fetchImpl?: typeof fetch;
};

const getEnvRegistryUrlOverride = (): string | undefined => {
  const envCandidates = [
    process.env.CLAWDENTITY_REGISTRY_URL,
    process.env.CLAWDENTITY_REGISTRY,
  ];

  return envCandidates.find((value): value is string => {
    return typeof value === "string" && value.length > 0;
  });
};

export const createConfigCommand = (
  dependencies: ConfigCommandDependencies = {},
): Command => {
  const configCommand = new Command("config").description(
    "Manage local CLI configuration",
  );

  configCommand
    .command("init")
    .description("Initialize local config file")
    .option("--registry-url <url>", "Initialize config with registry URL")
    .action(
      withErrorHandling("config init", async (options: ConfigInitOptions) => {
        const configFilePath = getConfigFilePath();

        try {
          await access(configFilePath);
          writeStdoutLine(`Config already exists at ${configFilePath}`);
          return;
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }

        const config = await readConfig();
        const requestedRegistryUrl =
          options.registryUrl ??
          getEnvRegistryUrlOverride() ??
          config.registryUrl;
        const normalizedRegistryUrl =
          normalizeRegistryUrl(requestedRegistryUrl);
        const metadata = await fetchRegistryMetadata(normalizedRegistryUrl, {
          fetchImpl: dependencies.fetchImpl,
        });

        await writeConfig({
          ...config,
          registryUrl: metadata.registryUrl,
          proxyUrl: metadata.proxyUrl,
        });

        writeStdoutLine(`Initialized config at ${configFilePath}`);
        writeStdoutLine(
          JSON.stringify(
            maskApiKey({
              ...config,
              registryUrl: metadata.registryUrl,
              proxyUrl: metadata.proxyUrl,
            }),
            null,
            2,
          ),
        );
      }),
    );

  configCommand
    .command("set <key> <value>")
    .description("Set a config value")
    .action(
      withErrorHandling("config set", async (key: string, value: string) => {
        const validatedKey = getValidatedKey(key);

        if (!validatedKey) {
          return;
        }

        await setConfigValue(validatedKey, value);

        const printedValue = validatedKey === "apiKey" ? "********" : value;
        writeStdoutLine(`Set ${validatedKey}=${printedValue}`);
      }),
    );

  configCommand
    .command("get <key>")
    .description("Get a resolved config value")
    .action(
      withErrorHandling("config get", async (key: string) => {
        const validatedKey = getValidatedKey(key);

        if (!validatedKey) {
          return;
        }

        const value = await getConfigValue(validatedKey);

        if (value === undefined) {
          writeStdoutLine("(not set)");
          return;
        }

        writeStdoutLine(value);
      }),
    );

  configCommand
    .command("show")
    .description("Show resolved config values")
    .action(
      withErrorHandling("config show", async () => {
        const resolvedConfig = await resolveConfig();
        writeStdoutLine(JSON.stringify(maskApiKey(resolvedConfig), null, 2));
      }),
    );

  return configCommand;
};
