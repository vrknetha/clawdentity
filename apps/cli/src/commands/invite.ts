import { INVITES_PATH, INVITES_REDEEM_PATH } from "@clawdentity/protocol";
import { AppError, createLogger } from "@clawdentity/sdk";
import { Command } from "commander";
import {
  type CliConfig,
  resolveConfig,
  setConfigValue,
} from "../config/manager.js";
import {
  fetchRegistryMetadata,
  normalizeRegistryUrl,
  toRegistryRequestUrl,
} from "../config/registry-metadata.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "invite" });

type InviteCreateOptions = {
  expiresAt?: string;
  registryUrl?: string;
};

type InviteRedeemOptions = {
  registryUrl?: string;
  displayName?: string;
  apiKeyName?: string;
};

type InviteRecord = {
  code: string;
  id?: string;
  createdAt?: string;
  expiresAt?: string | null;
};

export type InviteCreateResult = {
  invite: InviteRecord;
  registryUrl: string;
};

export type InviteRedeemResult = {
  apiKeyToken: string;
  apiKeyId?: string;
  apiKeyName?: string;
  humanName: string;
  proxyUrl: string;
  registryUrl: string;
};

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

type InviteDependencies = {
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: () => Promise<CliConfig>;
};

type InvitePersistenceDependencies = {
  setConfigValueImpl?: typeof setConfigValue;
};

type InviteCommandDependencies = InviteDependencies &
  InvitePersistenceDependencies;

type InviteRuntime = {
  fetchImpl: typeof fetch;
  registryUrl: string;
  config: CliConfig;
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

function normalizeProxyUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("invalid protocol");
    }

    return parsed.toString();
  } catch {
    throw createCliError(
      "CLI_INVITE_REDEEM_INVALID_RESPONSE",
      "Invite redeem response is invalid",
    );
  }
}

function resolveRegistryUrl(input: {
  overrideRegistryUrl: string | undefined;
  configRegistryUrl: string;
}): string {
  const candidate =
    parseNonEmptyString(input.overrideRegistryUrl) || input.configRegistryUrl;
  return normalizeRegistryUrl(candidate);
}

function requireApiKey(config: CliConfig): string {
  if (typeof config.apiKey === "string" && config.apiKey.trim().length > 0) {
    return config.apiKey;
  }

  throw createCliError(
    "CLI_INVITE_MISSING_LOCAL_CREDENTIALS",
    "API key is not configured. Run `clawdentity config set apiKey <token>` or set CLAWDENTITY_API_KEY.",
  );
}

function extractRegistryErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.code !== "string") {
    return undefined;
  }

  const trimmed = envelope.error.code.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function executeInviteRequest(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
}): Promise<Response> {
  try {
    return await input.fetchImpl(input.url, input.init);
  } catch {
    throw createCliError(
      "CLI_INVITE_REQUEST_FAILED",
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }
}

function mapCreateInviteError(status: number, payload: unknown): string {
  const errorCode = extractRegistryErrorCode(payload);
  const registryMessage = extractRegistryErrorMessage(payload);

  if (status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (status === 403) {
    return registryMessage
      ? `Invite creation requires admin access (403): ${registryMessage}`
      : "Invite creation requires admin access (403).";
  }

  if (status === 400) {
    return registryMessage
      ? `Registry rejected invite request (400): ${registryMessage}`
      : "Registry rejected invite request (400).";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (errorCode && registryMessage) {
    return `Invite creation failed (${errorCode}): ${registryMessage}`;
  }

  if (registryMessage) {
    return `Invite creation failed (${status}): ${registryMessage}`;
  }

  return `Invite creation failed (${status})`;
}

function mapRedeemInviteError(status: number, payload: unknown): string {
  const errorCode = extractRegistryErrorCode(payload);
  const registryMessage = extractRegistryErrorMessage(payload);

  if (
    errorCode === "INVITE_REDEEM_ALREADY_USED" ||
    errorCode === "INVITE_REDEEM_ALREADY_REDEEMED"
  ) {
    return "Invite code has already been redeemed";
  }

  if (errorCode === "INVITE_REDEEM_EXPIRED") {
    return "Invite code has expired";
  }

  if (
    errorCode === "INVITE_REDEEM_CODE_INVALID" ||
    errorCode === "INVITE_REDEEM_INVALID_CODE"
  ) {
    return "Invite code is invalid";
  }

  if (status === 400 || status === 404 || status === 409) {
    return registryMessage
      ? `Invite redeem failed (${status}): ${registryMessage}`
      : "Invite code is invalid or unavailable";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Invite redeem failed (${status}): ${registryMessage}`;
  }

  return `Invite redeem failed (${status})`;
}

function parseInviteRecord(payload: unknown): InviteRecord {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_INVITE_CREATE_INVALID_RESPONSE",
      "Invite response is invalid",
    );
  }

  const source = isRecord(payload.invite) ? payload.invite : payload;
  const code = parseNonEmptyString(source.code);
  if (code.length === 0) {
    throw createCliError(
      "CLI_INVITE_CREATE_INVALID_RESPONSE",
      "Invite response is invalid",
    );
  }

  const invite: InviteRecord = {
    code,
  };

  const id = parseNonEmptyString(source.id);
  if (id.length > 0) {
    invite.id = id;
  }

  const createdAt = parseNonEmptyString(source.createdAt);
  if (createdAt.length > 0) {
    invite.createdAt = createdAt;
  }

  if (source.expiresAt === null || typeof source.expiresAt === "string") {
    invite.expiresAt = source.expiresAt;
  }

  return invite;
}

function parseInviteRedeemResponse(
  payload: unknown,
): Omit<InviteRedeemResult, "registryUrl"> {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_INVITE_REDEEM_INVALID_RESPONSE",
      "Invite redeem response is invalid",
    );
  }

  const apiKeySource = isRecord(payload.apiKey) ? payload.apiKey : payload;
  const apiKeyToken = parseNonEmptyString(
    isRecord(payload.apiKey) ? payload.apiKey.token : payload.token,
  );
  if (apiKeyToken.length === 0) {
    throw createCliError(
      "CLI_INVITE_REDEEM_INVALID_RESPONSE",
      "Invite redeem response is invalid",
    );
  }

  const apiKeyId = parseNonEmptyString(apiKeySource.id);
  const apiKeyName = parseNonEmptyString(apiKeySource.name);
  const humanSource = isRecord(payload.human) ? payload.human : undefined;
  const humanName = parseNonEmptyString(humanSource?.displayName);
  const proxyUrl = parseNonEmptyString(payload.proxyUrl);

  if (humanName.length === 0) {
    throw createCliError(
      "CLI_INVITE_REDEEM_INVALID_RESPONSE",
      "Invite redeem response is invalid",
    );
  }

  return {
    apiKeyToken,
    apiKeyId: apiKeyId.length > 0 ? apiKeyId : undefined,
    apiKeyName: apiKeyName.length > 0 ? apiKeyName : undefined,
    humanName,
    proxyUrl,
  };
}

async function resolveInviteRuntime(
  overrideRegistryUrl: string | undefined,
  dependencies: InviteDependencies,
): Promise<InviteRuntime> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const resolveConfigImpl = dependencies.resolveConfigImpl ?? resolveConfig;
  const config = await resolveConfigImpl();
  const registryUrl = resolveRegistryUrl({
    overrideRegistryUrl,
    configRegistryUrl: config.registryUrl,
  });

  return {
    fetchImpl,
    registryUrl,
    config,
  };
}

export async function createInvite(
  options: InviteCreateOptions,
  dependencies: InviteDependencies = {},
): Promise<InviteCreateResult> {
  const runtime = await resolveInviteRuntime(options.registryUrl, dependencies);
  const apiKey = requireApiKey(runtime.config);

  const response = await executeInviteRequest({
    fetchImpl: runtime.fetchImpl,
    url: toRegistryRequestUrl(runtime.registryUrl, INVITES_PATH),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expiresAt: parseNonEmptyString(options.expiresAt) || undefined,
      }),
    },
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_INVITE_CREATE_FAILED",
      mapCreateInviteError(response.status, responseBody),
    );
  }

  return {
    invite: parseInviteRecord(responseBody),
    registryUrl: runtime.registryUrl,
  };
}

export async function redeemInvite(
  code: string,
  options: InviteRedeemOptions,
  dependencies: InviteDependencies = {},
): Promise<InviteRedeemResult> {
  const inviteCode = parseNonEmptyString(code);
  if (inviteCode.length === 0) {
    throw createCliError(
      "CLI_INVITE_REDEEM_CODE_REQUIRED",
      "Invite code is required",
    );
  }

  const displayName = parseNonEmptyString(options.displayName);
  if (displayName.length === 0) {
    throw createCliError(
      "CLI_INVITE_REDEEM_DISPLAY_NAME_REQUIRED",
      "Display name is required. Pass --display-name <name>.",
    );
  }
  const apiKeyName = parseNonEmptyString(options.apiKeyName);

  const runtime = await resolveInviteRuntime(options.registryUrl, dependencies);
  const response = await executeInviteRequest({
    fetchImpl: runtime.fetchImpl,
    url: toRegistryRequestUrl(runtime.registryUrl, INVITES_REDEEM_PATH),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code: inviteCode,
        displayName,
        apiKeyName: apiKeyName.length > 0 ? apiKeyName : undefined,
      }),
    },
  });

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_INVITE_REDEEM_FAILED",
      mapRedeemInviteError(response.status, responseBody),
    );
  }

  const parsedRedeem = parseInviteRedeemResponse(responseBody);
  const proxyUrl =
    parsedRedeem.proxyUrl.length > 0
      ? parsedRedeem.proxyUrl
      : (
          await fetchRegistryMetadata(runtime.registryUrl, {
            fetchImpl: runtime.fetchImpl,
          })
        ).proxyUrl;

  return {
    ...parsedRedeem,
    proxyUrl: normalizeProxyUrl(proxyUrl),
    registryUrl: runtime.registryUrl,
  };
}

export async function persistRedeemConfig(
  registryUrl: string,
  apiKeyToken: string,
  proxyUrl: string,
  humanName: string,
  dependencies: InvitePersistenceDependencies = {},
): Promise<void> {
  const setConfigValueImpl = dependencies.setConfigValueImpl ?? setConfigValue;

  try {
    await setConfigValueImpl("registryUrl", registryUrl);
    await setConfigValueImpl("apiKey", apiKeyToken);
    await setConfigValueImpl("proxyUrl", proxyUrl);
    await setConfigValueImpl("humanName", humanName);
  } catch (error) {
    logger.warn("cli.invite_redeem_config_persist_failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw createCliError(
      "CLI_INVITE_REDEEM_CONFIG_PERSISTENCE_FAILED",
      "Failed to save redeemed API key locally",
    );
  }
}

export const createInviteCommand = (
  dependencies: InviteCommandDependencies = {},
): Command => {
  const inviteCommand = new Command("invite").description(
    "Manage registry onboarding invites (not OpenClaw peer relay invites)",
  );

  inviteCommand
    .command("create")
    .description("Create a registry invite code (admin only)")
    .option("--expires-at <timestamp>", "Optional invite expiry (ISO-8601)")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling(
        "invite create",
        async (options: InviteCreateOptions) => {
          const result = await createInvite(options, dependencies);

          logger.info("cli.invite_created", {
            code: result.invite.code,
            id: result.invite.id,
            registryUrl: result.registryUrl,
          });

          writeStdoutLine("Invite created");
          writeStdoutLine(`Code: ${result.invite.code}`);
          if (result.invite.id) {
            writeStdoutLine(`ID: ${result.invite.id}`);
          }

          writeStdoutLine(`Expires At: ${result.invite.expiresAt ?? "never"}`);
        },
      ),
    );

  inviteCommand
    .command("redeem <code>")
    .description("Redeem a registry invite code and store PAT locally")
    .requiredOption(
      "--display-name <name>",
      "Human display name used for onboarding",
    )
    .option("--api-key-name <name>", "Optional API key label")
    .option("--registry-url <url>", "Override registry URL")
    .action(
      withErrorHandling(
        "invite redeem",
        async (code: string, options: InviteRedeemOptions) => {
          const result = await redeemInvite(code, options, dependencies);

          logger.info("cli.invite_redeemed", {
            apiKeyId: result.apiKeyId,
            apiKeyName: result.apiKeyName,
            humanName: result.humanName,
            registryUrl: result.registryUrl,
          });

          writeStdoutLine("Invite redeemed");
          writeStdoutLine(`Human name: ${result.humanName}`);
          if (result.apiKeyName) {
            writeStdoutLine(`API key name: ${result.apiKeyName}`);
          }

          writeStdoutLine("API key token (shown once):");
          writeStdoutLine(result.apiKeyToken);

          await persistRedeemConfig(
            result.registryUrl,
            result.apiKeyToken,
            result.proxyUrl,
            result.humanName,
            dependencies,
          );
          writeStdoutLine("API key saved to local config");
        },
      ),
    );

  return inviteCommand;
};
