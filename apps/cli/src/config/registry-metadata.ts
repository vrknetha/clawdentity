import { REGISTRY_METADATA_PATH } from "@clawdentity/protocol";
import { AppError } from "@clawdentity/sdk";

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

export type RegistryMetadata = {
  environment?: string;
  proxyUrl: string;
  registryUrl: string;
  version?: string;
};

export type RegistryMetadataDependencies = {
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

function parseUrl(candidate: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw createCliError("CLI_REGISTRY_URL_INVALID", `${label} is invalid`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw createCliError("CLI_REGISTRY_URL_INVALID", `${label} is invalid`);
  }

  return parsed;
}

export function normalizeRegistryUrl(registryUrl: string): string {
  return parseUrl(registryUrl, "Registry URL").toString();
}

export function toRegistryRequestUrl(
  registryUrl: string,
  path: string,
): string {
  const normalizedRegistryUrl = normalizeRegistryUrl(registryUrl);
  const base = normalizedRegistryUrl.endsWith("/")
    ? normalizedRegistryUrl
    : `${normalizedRegistryUrl}/`;

  return new URL(path.slice(1), base).toString();
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

function parseMetadataPayload(
  payload: unknown,
  fallbackRegistryUrl: string,
): RegistryMetadata {
  if (!isRecord(payload)) {
    throw createCliError(
      "CLI_REGISTRY_METADATA_INVALID_RESPONSE",
      "Registry metadata response is invalid",
    );
  }

  const proxyUrlRaw = parseNonEmptyString(payload.proxyUrl);
  if (proxyUrlRaw.length === 0) {
    throw createCliError(
      "CLI_REGISTRY_METADATA_INVALID_RESPONSE",
      "Registry metadata response is invalid",
    );
  }

  const proxyUrl = parseUrl(proxyUrlRaw, "Proxy URL").toString();

  const registryUrlRaw = parseNonEmptyString(payload.registryUrl);
  const registryUrl =
    registryUrlRaw.length > 0
      ? parseUrl(registryUrlRaw, "Registry URL").toString()
      : normalizeRegistryUrl(fallbackRegistryUrl);

  const environment = parseNonEmptyString(payload.environment);
  const version = parseNonEmptyString(payload.version);

  return {
    proxyUrl,
    registryUrl,
    environment: environment.length > 0 ? environment : undefined,
    version: version.length > 0 ? version : undefined,
  };
}

function mapMetadataError(status: number, payload: unknown): string {
  const registryMessage = extractRegistryErrorMessage(payload);

  if (status === 404) {
    return "Registry metadata endpoint is unavailable (404).";
  }

  if (status >= 500) {
    return `Registry metadata request failed (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry metadata request failed (${status}): ${registryMessage}`;
  }

  return `Registry metadata request failed (${status}).`;
}

export async function fetchRegistryMetadata(
  registryUrl: string,
  dependencies: RegistryMetadataDependencies = {},
): Promise<RegistryMetadata> {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw createCliError(
      "CLI_REGISTRY_METADATA_FETCH_UNAVAILABLE",
      "Runtime fetch is unavailable for registry metadata lookup",
    );
  }

  const normalizedRegistryUrl = normalizeRegistryUrl(registryUrl);
  const requestUrl = toRegistryRequestUrl(
    normalizedRegistryUrl,
    REGISTRY_METADATA_PATH,
  );

  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    throw createCliError(
      "CLI_REGISTRY_METADATA_REQUEST_FAILED",
      "Unable to reach registry metadata endpoint. Check registryUrl and network access.",
    );
  }

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw createCliError(
      "CLI_REGISTRY_METADATA_FETCH_FAILED",
      mapMetadataError(response.status, payload),
    );
  }

  return parseMetadataPayload(payload, normalizedRegistryUrl);
}
