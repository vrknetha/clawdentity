import { parseJsonResponseSafe as parseJsonResponse } from "@clawdentity/common";
import { ME_API_KEYS_PATH, parseUlid } from "@clawdentity/protocol";
import { AppError, createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import { type CliConfig, resolveConfig } from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "api-key" });

type ApiKeyCreateOptions = {
  name?: string;
  registryUrl?: string;
};

type ApiKeyListOptions = {
  registryUrl?: string;
};

type ApiKeyRevokeOptions = {
  registryUrl?: string;
};

type ApiKeyMetadata = {
  id: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

type ApiKeyCreateResult = {
  apiKey: ApiKeyMetadata & {
    token: string;
  };
  registryUrl: string;
};

type ApiKeyListResult = {
  apiKeys: ApiKeyMetadata[];
  registryUrl: string;
};

type RegistryErrorEnvelope = {
  error?: {
    message?: string;
  };
};

type ApiKeyDependencies = {
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: () => Promise<CliConfig>;
};

type ApiKeyRuntime = {
  fetchImpl: typeof fetch;
  registryUrl: string;
  apiKey: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

function parseNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function createCliError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    status: 400,
  });
}

function resolveRegistryUrl(input: {
  overrideRegistryUrl: string | undefined;
  configRegistryUrl: string;
}): string {
  const candidate =
    parseNonEmptyString(input.overrideRegistryUrl) || input.configRegistryUrl;

  try {
    return new URL(candidate).toString();
  } catch {
    throw createCliError(
      "CLI_API_KEY_INVALID_REGISTRY_URL",
      "Registry URL is invalid",
    );
  }
}

function requireApiKey(config: CliConfig): string {
  if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) {
    return config.apiKey;
  }

  throw createCliError(
    "CLI_API_KEY_MISSING_LOCAL_CREDENTIALS",
    "API key is not configured. Run `clawdentity config set apiKey <token>` or set CLAWDENTITY_API_KEY.",
  );
}

function toApiKeyRequestUrl(registryUrl: string, apiKeyId?: string): string {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;
  const path = apiKeyId
    ? `${ME_API_KEYS_PATH.slice(1)}/${encodeURIComponent(apiKeyId)}`
    : ME_API_KEYS_PATH.slice(1);

  return new URL(path, normalizedBaseUrl).toString();
}

function extractRegistryErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.message !== "string") {
    return undefined;
  }

  const trimmed = envelope.error.message.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toHttpErrorMessage(options: {
  status: number;
  responseBody: unknown;
  notFoundPrefix: string;
}): string {
  const registryMessage = extractRegistryErrorMessage(options.responseBody);

  if (options.status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (options.status === 400) {
    return registryMessage
      ? `Registry rejected the request (400): ${registryMessage}`
      : "Registry rejected the request (400).";
  }

  if (options.status === 404) {
    return registryMessage
      ? `${options.notFoundPrefix} (404): ${registryMessage}`
      : `${options.notFoundPrefix} not found in the registry (404).`;
  }

  if (options.status >= 500) {
    return `Registry server error (${options.status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry request failed (${options.status}): ${registryMessage}`;
  }

  return `Registry request failed (${options.status})`;
}

function parseApiKeyMetadata(payload: unknown): ApiKeyMetadata {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_API_KEY_INVALID_RESPONSE",
      "API key response is invalid",
    );
  }

  const id = parseNonEmptyString(payload.id);
  const name = parseNonEmptyString(payload.name);
  const status = payload.status;
  const createdAt = parseNonEmptyString(payload.createdAt);
  const lastUsedAt = payload.lastUsedAt;

  if (
    id.length === 0 ||
    name.length === 0 ||
    (status !== "active" && status !== "revoked") ||
    createdAt.length === 0 ||
    (lastUsedAt !== null && typeof lastUsedAt !== "string")
  ) {
    throw createCliError(
      "CLI_API_KEY_INVALID_RESPONSE",
      "API key response is invalid",
    );
  }

  return {
    id,
    name,
    status,
    createdAt,
    lastUsedAt,
  };
}

function parseApiKeyCreateResponse(
  payload: unknown,
): ApiKeyCreateResult["apiKey"] {
  if (!isRecord(payload) || !isRecord(payload.apiKey)) {
    throw createCliError(
      "CLI_API_KEY_INVALID_RESPONSE",
      "API key response is invalid",
    );
  }

  const metadata = parseApiKeyMetadata(payload.apiKey);
  const token = parseNonEmptyString(payload.apiKey.token);
  if (token.length === 0) {
    throw createCliError(
      "CLI_API_KEY_INVALID_RESPONSE",
      "API key response is invalid",
    );
  }

  return {
    ...metadata,
    token,
  };
}

function parseApiKeyListResponse(payload: unknown): ApiKeyMetadata[] {
  if (!isRecord(payload) || !Array.isArray(payload.apiKeys)) {
    throw createCliError(
      "CLI_API_KEY_INVALID_RESPONSE",
      "API key response is invalid",
    );
  }

  return payload.apiKeys.map((item) => parseApiKeyMetadata(item));
}

function parseApiKeyId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw createCliError("CLI_API_KEY_ID_REQUIRED", "API key id is required");
  }

  try {
    return parseUlid(trimmed).value;
  } catch {
    throw createCliError(
      "CLI_API_KEY_ID_INVALID",
      "API key id must be a valid ULID",
    );
  }
}

async function resolveApiKeyRuntime(
  overrideRegistryUrl: string | undefined,
  dependencies: ApiKeyDependencies,
): Promise<ApiKeyRuntime> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const config = await resolveConfigImpl();
  const apiKey = requireApiKey(config);
  const registryUrl = resolveRegistryUrl({
    overrideRegistryUrl,
    configRegistryUrl: config.registryUrl,
  });

  return {
    fetchImpl,
    registryUrl,
    apiKey,
  };
}

async function executeApiKeyRequest(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
}): Promise<Response> {
  try {
    return await input.fetchImpl(input.url, input.init);
  } catch {
    throw createCliError(
      "CLI_API_KEY_REQUEST_FAILED",
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }
}

export async function createApiKey(
  options: ApiKeyCreateOptions,
  dependencies: ApiKeyDependencies = {},
): Promise<ApiKeyCreateResult> {
  const runtime = await resolveApiKeyRuntime(options.registryUrl, dependencies);

  const response = await executeApiKeyRequest({
    fetchImpl: runtime.fetchImpl,
    url: toApiKeyRequestUrl(runtime.registryUrl),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: parseNonEmptyString(options.name) || undefined,
      }),
    },
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_API_KEY_CREATE_FAILED",
      toHttpErrorMessage({
        status: response.status,
        responseBody,
        notFoundPrefix: "API key",
      }),
    );
  }

  return {
    apiKey: parseApiKeyCreateResponse(responseBody),
    registryUrl: runtime.registryUrl,
  };
}

export async function listApiKeys(
  options: ApiKeyListOptions,
  dependencies: ApiKeyDependencies = {},
): Promise<ApiKeyListResult> {
  const runtime = await resolveApiKeyRuntime(options.registryUrl, dependencies);

  const response = await executeApiKeyRequest({
    fetchImpl: runtime.fetchImpl,
    url: toApiKeyRequestUrl(runtime.registryUrl),
    init: {
      method: "GET",
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
      },
    },
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_API_KEY_LIST_FAILED",
      toHttpErrorMessage({
        status: response.status,
        responseBody,
        notFoundPrefix: "API key",
      }),
    );
  }

  return {
    apiKeys: parseApiKeyListResponse(responseBody),
    registryUrl: runtime.registryUrl,
  };
}

export async function revokeApiKey(
  id: string,
  options: ApiKeyRevokeOptions,
  dependencies: ApiKeyDependencies = {},
): Promise<{ apiKeyId: string; registryUrl: string }> {
  const runtime = await resolveApiKeyRuntime(options.registryUrl, dependencies);
  const apiKeyId = parseApiKeyId(id);

  const response = await executeApiKeyRequest({
    fetchImpl: runtime.fetchImpl,
    url: toApiKeyRequestUrl(runtime.registryUrl, apiKeyId),
    init: {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
      },
    },
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_API_KEY_REVOKE_FAILED",
      toHttpErrorMessage({
        status: response.status,
        responseBody,
        notFoundPrefix: "API key",
      }),
    );
  }

  return { apiKeyId, registryUrl: runtime.registryUrl };
}

export const createApiKeyCommand = (
  dependencies: ApiKeyDependencies = {},
): Command => {
  const apiKeyCommand = new Command("api-key").description(
    "Manage personal API keys for registry access",
  );

  apiKeyCommand
    .command("create")
    .description("Create a new personal API key")
    .option("--name <name>", "API key label")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling(
        "api-key create",
        async (options: ApiKeyCreateOptions) => {
          const result = await createApiKey(options, dependencies);

          logger.info("cli.api_key_created", {
            id: result.apiKey.id,
            name: result.apiKey.name,
            status: result.apiKey.status,
            registryUrl: result.registryUrl,
          });

          writeStdoutLine("API key created");
          writeStdoutLine(`ID: ${result.apiKey.id}`);
          writeStdoutLine(`Name: ${result.apiKey.name}`);
          writeStdoutLine(`Status: ${result.apiKey.status}`);
          writeStdoutLine(`Created At: ${result.apiKey.createdAt}`);
          writeStdoutLine(
            `Last Used At: ${result.apiKey.lastUsedAt ?? "never"}`,
          );
          writeStdoutLine("Token (shown once):");
          writeStdoutLine(result.apiKey.token);
        },
      ),
    );

  apiKeyCommand
    .command("list")
    .description("List personal API keys")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling("api-key list", async (options: ApiKeyListOptions) => {
        const result = await listApiKeys(options, dependencies);

        logger.info("cli.api_key_listed", {
          count: result.apiKeys.length,
          registryUrl: result.registryUrl,
        });

        if (result.apiKeys.length === 0) {
          writeStdoutLine("No API keys found.");
          return;
        }

        for (const apiKey of result.apiKeys) {
          writeStdoutLine(
            `${apiKey.id} | ${apiKey.name} | ${apiKey.status} | created ${apiKey.createdAt} | last used ${apiKey.lastUsedAt ?? "never"}`,
          );
        }
      }),
    );

  apiKeyCommand
    .command("revoke <id>")
    .description("Revoke a personal API key by id")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling(
        "api-key revoke",
        async (id: string, options: ApiKeyRevokeOptions) => {
          const result = await revokeApiKey(id, options, dependencies);

          logger.info("cli.api_key_revoked", {
            id: result.apiKeyId,
            registryUrl: result.registryUrl,
          });

          writeStdoutLine(`API key revoked: ${result.apiKeyId}`);
        },
      ),
    );

  return apiKeyCommand;
};
