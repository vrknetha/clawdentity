import { parseJsonResponseSafe as parseJsonResponse } from "@clawdentity/common";
import {
  AGENT_AUTH_REFRESH_PATH,
  encodeBase64url,
} from "@clawdentity/protocol";
import { nowUtcMs } from "./datetime.js";
import { AppError } from "./exceptions.js";
import { signHttpRequest } from "./http/sign.js";

export type AgentAuthBundle = {
  tokenType: "Bearer";
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
};

type RegistryErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
  };
};

type RefreshSingleFlightOptions<T> = {
  key: string;
  run: () => Promise<T>;
};

const refreshSingleFlights = new Map<string, Promise<unknown>>();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const parseNonEmptyString = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
};

const toPathWithQuery = (requestUrl: string): string => {
  const parsed = new URL(requestUrl);
  return `${parsed.pathname}${parsed.search}`;
};

const parseRegistryErrorEnvelope = (
  payload: unknown,
): RegistryErrorEnvelope | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const errorValue = payload.error;
  if (!isRecord(errorValue)) {
    return undefined;
  }

  return {
    error: {
      code: parseNonEmptyString(errorValue.code) || undefined,
      message: parseNonEmptyString(errorValue.message) || undefined,
    },
  };
};

const parseAgentAuthBundle = (payload: unknown): AgentAuthBundle => {
  if (!isRecord(payload)) {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_INVALID_RESPONSE",
      message: "Registry returned an invalid refresh response payload",
      status: 502,
      expose: true,
    });
  }

  const source = isRecord(payload.agentAuth) ? payload.agentAuth : payload;

  const tokenType = source.tokenType;
  const accessToken = source.accessToken;
  const accessExpiresAt = source.accessExpiresAt;
  const refreshToken = source.refreshToken;
  const refreshExpiresAt = source.refreshExpiresAt;

  if (
    tokenType !== "Bearer" ||
    typeof accessToken !== "string" ||
    typeof accessExpiresAt !== "string" ||
    typeof refreshToken !== "string" ||
    typeof refreshExpiresAt !== "string"
  ) {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_INVALID_RESPONSE",
      message: "Registry returned an invalid refresh response payload",
      status: 502,
      expose: true,
    });
  }

  return {
    tokenType,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
};

const toRefreshHttpError = (
  status: number,
  responseBody: unknown,
): AppError => {
  const parsedEnvelope = parseRegistryErrorEnvelope(responseBody);
  const registryCode = parsedEnvelope?.error?.code;
  const registryMessage = parsedEnvelope?.error?.message;

  if (status === 400) {
    return new AppError({
      code: "AGENT_AUTH_REFRESH_INVALID",
      message: registryMessage ?? "Refresh request is invalid (400).",
      status,
      expose: true,
      details: {
        registryCode,
        registryMessage,
      },
    });
  }

  if (status === 401) {
    return new AppError({
      code: "AGENT_AUTH_REFRESH_UNAUTHORIZED",
      message:
        registryMessage ??
        "Refresh rejected (401). Agent credentials are invalid, revoked, or expired.",
      status,
      expose: true,
      details: {
        registryCode,
        registryMessage,
      },
    });
  }

  if (status === 409) {
    return new AppError({
      code: "AGENT_AUTH_REFRESH_CONFLICT",
      message: registryMessage ?? "Refresh conflict (409). Retry request.",
      status,
      expose: true,
      details: {
        registryCode,
        registryMessage,
      },
    });
  }

  if (status >= 500) {
    return new AppError({
      code: "AGENT_AUTH_REFRESH_SERVER_ERROR",
      message: `Registry server error (${status}). Try again later.`,
      status: 503,
      expose: true,
      details: {
        status,
      },
    });
  }

  return new AppError({
    code: "AGENT_AUTH_REFRESH_FAILED",
    message:
      registryMessage ?? `Registry request failed during refresh (${status}).`,
    status,
    expose: true,
    details: {
      registryCode,
      registryMessage,
      status,
    },
  });
};

const toRegistryAgentAuthRefreshRequestUrl = (registryUrl: string): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  return new URL(
    AGENT_AUTH_REFRESH_PATH.slice(1),
    normalizedBaseUrl,
  ).toString();
};

async function runRefreshSingleFlight<T>(
  options: RefreshSingleFlightOptions<T>,
): Promise<T> {
  const existing = refreshSingleFlights.get(options.key);
  if (existing) {
    return existing as Promise<T>;
  }

  const inFlight = options.run().finally(() => {
    if (refreshSingleFlights.get(options.key) === inFlight) {
      refreshSingleFlights.delete(options.key);
    }
  });
  refreshSingleFlights.set(options.key, inFlight);
  return inFlight;
}

export async function refreshAgentAuthWithClawProof(input: {
  registryUrl: string;
  ait: string;
  secretKey: Uint8Array;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): Promise<AgentAuthBundle> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_NETWORK",
      message: "fetch implementation is required",
      status: 500,
      expose: true,
    });
  }

  const refreshUrl = toRegistryAgentAuthRefreshRequestUrl(input.registryUrl);
  const refreshBody = JSON.stringify({
    refreshToken: input.refreshToken,
  });
  const nowMs = input.nowMs?.() ?? nowUtcMs();
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const signed = await signHttpRequest({
    method: "POST",
    pathWithQuery: toPathWithQuery(refreshUrl),
    timestamp,
    nonce,
    body: new TextEncoder().encode(refreshBody),
    secretKey: input.secretKey,
  });

  let response: Response;
  try {
    response = await fetchImpl(refreshUrl, {
      method: "POST",
      headers: {
        authorization: `Claw ${input.ait}`,
        "content-type": "application/json",
        ...signed.headers,
      },
      body: refreshBody,
    });
  } catch {
    throw new AppError({
      code: "AGENT_AUTH_REFRESH_NETWORK",
      message:
        "Unable to connect to the registry. Check network access and registryUrl.",
      status: 503,
      expose: true,
    });
  }

  const responseBody = await parseJsonResponse(response);
  if (!response.ok) {
    throw toRefreshHttpError(response.status, responseBody);
  }

  return parseAgentAuthBundle(responseBody);
}

export function isRetryableAuthExpiryError(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }

  return error.status === 401;
}

export async function executeWithAgentAuthRefreshRetry<T>(input: {
  key: string;
  getAuth: () => Promise<AgentAuthBundle>;
  refreshAuth: (currentAuth: AgentAuthBundle) => Promise<AgentAuthBundle>;
  persistAuth: (refreshedAuth: AgentAuthBundle) => Promise<void>;
  perform: (auth: AgentAuthBundle) => Promise<T>;
  shouldRetry?: (error: unknown) => boolean;
}): Promise<T> {
  const shouldRetry = input.shouldRetry ?? isRetryableAuthExpiryError;
  const currentAuth = await input.getAuth();

  try {
    return await input.perform(currentAuth);
  } catch (error) {
    if (!shouldRetry(error)) {
      throw error;
    }

    const refreshedAuth = await runRefreshSingleFlight({
      key: input.key,
      run: async () => {
        const latestAuth = await input.getAuth();
        const nextAuth = await input.refreshAuth(latestAuth);
        await input.persistAuth(nextAuth);
        return nextAuth;
      },
    });

    return input.perform(refreshedAuth);
  }
}
