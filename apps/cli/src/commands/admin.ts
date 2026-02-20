import { ADMIN_BOOTSTRAP_PATH } from "@clawdentity/protocol";
import { AppError, createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import {
  type CliConfig,
  resolveConfig,
  setConfigValue,
} from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "admin" });

type AdminBootstrapOptions = {
  bootstrapSecret: string;
  displayName?: string;
  apiKeyName?: string;
  registryUrl?: string;
};

type AdminBootstrapResponse = {
  human: {
    id: string;
    did: string;
    displayName: string;
    role: "admin";
    status: "active";
  };
  apiKey: {
    id: string;
    name: string;
    token: string;
  };
  internalService: {
    id: string;
    name: string;
    secret: string;
  };
};

export type AdminBootstrapResult = AdminBootstrapResponse & {
  registryUrl: string;
};

type BootstrapErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

type AdminBootstrapDependencies = {
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: () => Promise<CliConfig>;
};

type AdminBootstrapPersistenceDependencies = {
  setConfigValueImpl?: typeof setConfigValue;
};

function createCliError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    status: 400,
  });
}

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function resolveBootstrapRegistryUrl(input: {
  overrideRegistryUrl: string | undefined;
  configRegistryUrl: string;
}): string {
  const candidate =
    parseNonEmptyString(input.overrideRegistryUrl) || input.configRegistryUrl;
  try {
    return new URL(candidate).toString();
  } catch {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_INVALID_REGISTRY_URL",
      "Registry URL is invalid",
    );
  }
}

function parseBootstrapResponse(payload: unknown): AdminBootstrapResponse {
  if (typeof payload !== "object" || payload === null) {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      "Bootstrap response is invalid",
    );
  }

  const body = payload as Record<string, unknown>;
  const human = body.human as Record<string, unknown> | undefined;
  const apiKey = body.apiKey as Record<string, unknown> | undefined;
  const internalService = body.internalService as
    | Record<string, unknown>
    | undefined;
  if (!human || !apiKey || !internalService) {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      "Bootstrap response is invalid",
    );
  }

  const humanId = parseNonEmptyString(human.id);
  const humanDid = parseNonEmptyString(human.did);
  const humanDisplayName = parseNonEmptyString(human.displayName);
  const apiKeyId = parseNonEmptyString(apiKey.id);
  const apiKeyName = parseNonEmptyString(apiKey.name);
  const apiKeyToken = parseNonEmptyString(apiKey.token);
  const internalServiceId = parseNonEmptyString(internalService.id);
  const internalServiceName = parseNonEmptyString(internalService.name);
  const internalServiceSecret = parseNonEmptyString(internalService.secret);

  if (
    humanId.length === 0 ||
    humanDid.length === 0 ||
    humanDisplayName.length === 0 ||
    apiKeyId.length === 0 ||
    apiKeyName.length === 0 ||
    apiKeyToken.length === 0 ||
    internalServiceId.length === 0 ||
    internalServiceName.length === 0 ||
    internalServiceSecret.length === 0
  ) {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      "Bootstrap response is invalid",
    );
  }

  return {
    human: {
      id: humanId,
      did: humanDid,
      displayName: humanDisplayName,
      role: "admin",
      status: "active",
    },
    apiKey: {
      id: apiKeyId,
      name: apiKeyName,
      token: apiKeyToken,
    },
    internalService: {
      id: internalServiceId,
      name: internalServiceName,
      secret: internalServiceSecret,
    },
  };
}

function mapBootstrapFailureMessage(payload: BootstrapErrorBody): string {
  if (payload.error?.code === "ADMIN_BOOTSTRAP_DISABLED") {
    return "Admin bootstrap is disabled on the registry";
  }

  if (payload.error?.code === "ADMIN_BOOTSTRAP_UNAUTHORIZED") {
    return "Bootstrap secret is invalid";
  }

  if (payload.error?.code === "ADMIN_BOOTSTRAP_ALREADY_COMPLETED") {
    return "Admin bootstrap has already completed";
  }

  if (payload.error?.code === "ADMIN_BOOTSTRAP_INVALID") {
    return "Bootstrap request payload is invalid";
  }

  return "Admin bootstrap request failed";
}

export async function bootstrapAdmin(
  options: AdminBootstrapOptions,
  dependencies: AdminBootstrapDependencies = {},
): Promise<AdminBootstrapResult> {
  const bootstrapSecret = parseNonEmptyString(options.bootstrapSecret);
  if (bootstrapSecret.length === 0) {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_SECRET_REQUIRED",
      "Bootstrap secret is required",
    );
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const config = await resolveConfigImpl();
  const registryUrl = resolveBootstrapRegistryUrl({
    overrideRegistryUrl: options.registryUrl,
    configRegistryUrl: config.registryUrl,
  });

  let response: Response;
  try {
    response = await fetchImpl(new URL(ADMIN_BOOTSTRAP_PATH, registryUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bootstrap-secret": bootstrapSecret,
      },
      body: JSON.stringify({
        displayName: parseNonEmptyString(options.displayName) || undefined,
        apiKeyName: parseNonEmptyString(options.apiKeyName) || undefined,
      }),
    });
  } catch (error) {
    logger.warn("cli.admin_bootstrap_request_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_REQUEST_FAILED",
      "Bootstrap request failed",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_INVALID_RESPONSE",
      "Bootstrap response is invalid",
    );
  }

  if (!response.ok) {
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_FAILED",
      mapBootstrapFailureMessage(payload as BootstrapErrorBody),
    );
  }

  const parsed = parseBootstrapResponse(payload);

  return {
    ...parsed,
    registryUrl,
  };
}

export async function persistBootstrapConfig(
  registryUrl: string,
  apiKeyToken: string,
  dependencies: AdminBootstrapPersistenceDependencies = {},
): Promise<void> {
  const setConfigValueImpl = dependencies.setConfigValueImpl ?? setConfigValue;

  try {
    await setConfigValueImpl("registryUrl", registryUrl);
    await setConfigValueImpl("apiKey", apiKeyToken);
  } catch (error) {
    logger.warn("cli.admin_bootstrap_config_persist_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw createCliError(
      "CLI_ADMIN_BOOTSTRAP_CONFIG_PERSISTENCE_FAILED",
      "Failed to save admin credentials locally",
    );
  }
}

export const createAdminCommand = (): Command => {
  const adminCommand = new Command("admin").description(
    "Manage admin bootstrap operations",
  );

  adminCommand
    .command("bootstrap")
    .description("Bootstrap first admin and store PAT locally")
    .requiredOption(
      "--bootstrap-secret <secret>",
      "One-time bootstrap secret configured on registry",
    )
    .option("--display-name <name>", "Admin display name")
    .option("--api-key-name <name>", "Admin API key label")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling(
        "admin bootstrap",
        async (options: AdminBootstrapOptions) => {
          const result = await bootstrapAdmin(options);
          writeStdoutLine("Admin bootstrap completed");
          writeStdoutLine(`Human DID: ${result.human.did}`);
          writeStdoutLine(`API key name: ${result.apiKey.name}`);
          writeStdoutLine("API key token (shown once):");
          writeStdoutLine(result.apiKey.token);
          writeStdoutLine(`Internal service ID: ${result.internalService.id}`);
          writeStdoutLine(
            `Internal service name: ${result.internalService.name}`,
          );
          writeStdoutLine("Internal service secret (shown once):");
          writeStdoutLine(result.internalService.secret);
          writeStdoutLine(
            "Set proxy secrets REGISTRY_INTERNAL_SERVICE_ID and REGISTRY_INTERNAL_SERVICE_SECRET with the values above before proxy deploy.",
          );

          await persistBootstrapConfig(result.registryUrl, result.apiKey.token);
          writeStdoutLine("API key saved to local config");
        },
      ),
    );

  return adminCommand;
};
