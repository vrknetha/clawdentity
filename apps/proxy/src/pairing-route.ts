import { parseDid } from "@clawdentity/protocol";
import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import {
  DEFAULT_PAIRING_CODE_TTL_SECONDS,
  MAX_PAIRING_CODE_TTL_SECONDS,
  OWNER_PAT_HEADER,
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
} from "./pairing-constants.js";
import {
  type ProxyTrustStore,
  ProxyTrustStoreError,
} from "./proxy-trust-store.js";

const REGISTRY_AGENT_OWNERSHIP_PATH_PREFIX = "/v1/agents";

export { OWNER_PAT_HEADER, PAIR_CONFIRM_PATH, PAIR_START_PATH };

type PairingRouteContext = Context<{
  Variables: ProxyRequestVariables;
}>;

export type PairStartRuntimeOptions = {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

type CreatePairStartHandlerOptions = PairStartRuntimeOptions & {
  logger: Logger;
  registryUrl: string;
  trustStore: ProxyTrustStore;
};

export type PairConfirmRuntimeOptions = {
  nowMs?: () => number;
};

type CreatePairConfirmHandlerOptions = PairConfirmRuntimeOptions & {
  logger: Logger;
  trustStore: ProxyTrustStore;
};

function parseOwnerPatHeader(headerValue: string | undefined): string {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_REQUIRED",
      message: "X-Claw-Owner-Pat header is required",
      status: 401,
      expose: true,
    });
  }

  return headerValue.trim();
}

function normalizeRegistryUrl(registryUrl: string): string {
  const baseUrl = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return new URL(baseUrl).toString();
}

function parseAgentDid(value: unknown, inputName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${inputName} is required`,
      status: 400,
      expose: true,
    });
  }

  const candidate = value.trim();
  try {
    const parsed = parseDid(candidate);
    if (parsed.kind !== "agent") {
      throw new Error("Invalid kind");
    }
  } catch {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${inputName} must be a valid agent DID`,
      status: 400,
      expose: true,
    });
  }

  return candidate;
}

function parseTtlSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PAIRING_CODE_TTL_SECONDS;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: "ttlSeconds must be an integer",
      status: 400,
      expose: true,
    });
  }

  if (value < 1 || value > MAX_PAIRING_CODE_TTL_SECONDS) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `ttlSeconds must be between 1 and ${MAX_PAIRING_CODE_TTL_SECONDS}`,
      status: 400,
      expose: true,
    });
  }

  return value;
}

async function parseJsonBody(c: PairingRouteContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: "Request body must be valid JSON",
      status: 400,
      expose: true,
    });
  }
}

async function parseRegistryOwnershipResponse(response: Response): Promise<{
  ownsAgent: boolean;
}> {
  const payload = (await response.json()) as {
    ownsAgent?: unknown;
  };
  if (typeof payload.ownsAgent !== "boolean") {
    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_UNAVAILABLE",
      message: "Registry owner lookup payload is invalid",
      status: 503,
      expose: true,
    });
  }

  return {
    ownsAgent: payload.ownsAgent,
  };
}

async function assertPatOwnsInitiatorAgent(input: {
  fetchImpl: typeof fetch;
  initiatorAgentDid: string;
  ownerPat: string;
  registryUrl: string;
}): Promise<void> {
  const parsedDid = parseDid(input.initiatorAgentDid);
  const ownershipUrl = new URL(
    `${REGISTRY_AGENT_OWNERSHIP_PATH_PREFIX}/${parsedDid.ulid}/ownership`,
    input.registryUrl,
  );

  let response: Response;
  try {
    response = await input.fetchImpl(ownershipUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.ownerPat}`,
      },
    });
  } catch {
    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_UNAVAILABLE",
      message: "Registry owner lookup is unavailable",
      status: 503,
      expose: true,
    });
  }

  if (response.status === 401) {
    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_INVALID",
      message: "Owner PAT is invalid or expired",
      status: 401,
      expose: true,
    });
  }

  if (!response.ok) {
    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_UNAVAILABLE",
      message: "Registry owner lookup is unavailable",
      status: 503,
      expose: true,
    });
  }

  let parsed: Awaited<ReturnType<typeof parseRegistryOwnershipResponse>>;
  try {
    parsed = await parseRegistryOwnershipResponse(response);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError({
      code: "PROXY_PAIR_OWNER_PAT_UNAVAILABLE",
      message: "Registry owner lookup payload is invalid",
      status: 503,
      expose: true,
    });
  }

  if (parsed.ownsAgent) {
    return;
  }

  throw new AppError({
    code: "PROXY_PAIR_OWNER_PAT_FORBIDDEN",
    message: "Owner PAT does not control caller agent DID",
    status: 403,
    expose: true,
  });
}

function toPairingCodeAppError(error: unknown): AppError {
  if (error instanceof ProxyTrustStoreError) {
    return new AppError({
      code: error.code,
      message: error.message,
      status: error.status,
      expose: true,
    });
  }

  return new AppError({
    code: "PROXY_PAIR_STATE_UNAVAILABLE",
    message: "Pairing state is unavailable",
    status: 503,
    expose: true,
  });
}

export function createPairStartHandler(
  options: CreatePairStartHandlerOptions,
): (c: PairingRouteContext) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const registryUrl = normalizeRegistryUrl(options.registryUrl);

  return async (c) => {
    const auth = c.get("auth");
    if (auth === undefined) {
      throw new AppError({
        code: "PROXY_PAIR_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const body = (await parseJsonBody(c)) as {
      agentDid?: unknown;
      ttlSeconds?: unknown;
    };

    const responderAgentDid = parseAgentDid(body.agentDid, "agentDid");
    if (responderAgentDid === auth.agentDid) {
      throw new AppError({
        code: "PROXY_PAIR_INVALID_BODY",
        message: "agentDid must be different from caller agent DID",
        status: 400,
        expose: true,
      });
    }

    const ttlSeconds = parseTtlSeconds(body.ttlSeconds);
    const ownerPat = parseOwnerPatHeader(c.req.header(OWNER_PAT_HEADER));

    await assertPatOwnsInitiatorAgent({
      fetchImpl,
      initiatorAgentDid: auth.agentDid,
      ownerPat,
      registryUrl,
    });

    const pairingCodeResult = await options.trustStore
      .createPairingCode({
        initiatorAgentDid: auth.agentDid,
        responderAgentDid,
        ttlSeconds,
        nowMs: nowMs(),
      })
      .catch((error: unknown) => {
        throw toPairingCodeAppError(error);
      });

    options.logger.info("proxy.pair.start", {
      requestId: c.get("requestId"),
      initiatorAgentDid: auth.agentDid,
      responderAgentDid,
      expiresAt: new Date(pairingCodeResult.expiresAtMs).toISOString(),
    });

    return c.json({
      initiatorAgentDid: pairingCodeResult.initiatorAgentDid,
      responderAgentDid: pairingCodeResult.responderAgentDid,
      pairingCode: pairingCodeResult.pairingCode,
      expiresAt: new Date(pairingCodeResult.expiresAtMs).toISOString(),
    });
  };
}

export function createPairConfirmHandler(
  options: CreatePairConfirmHandlerOptions,
): (c: PairingRouteContext) => Promise<Response> {
  const nowMs = options.nowMs ?? Date.now;

  return async (c) => {
    const auth = c.get("auth");
    if (auth === undefined) {
      throw new AppError({
        code: "PROXY_PAIR_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const body = (await parseJsonBody(c)) as {
      pairingCode?: unknown;
    };

    if (
      typeof body.pairingCode !== "string" ||
      body.pairingCode.trim() === ""
    ) {
      throw new AppError({
        code: "PROXY_PAIR_INVALID_BODY",
        message: "pairingCode is required",
        status: 400,
        expose: true,
      });
    }

    const consumedPairingCode = await options.trustStore
      .confirmPairingCode({
        pairingCode: body.pairingCode.trim(),
        responderAgentDid: auth.agentDid,
        nowMs: nowMs(),
      })
      .catch((error: unknown) => {
        throw toPairingCodeAppError(error);
      });

    options.logger.info("proxy.pair.confirm", {
      requestId: c.get("requestId"),
      initiatorAgentDid: consumedPairingCode.initiatorAgentDid,
      responderAgentDid: consumedPairingCode.responderAgentDid,
    });

    return c.json(
      {
        paired: true,
        initiatorAgentDid: consumedPairingCode.initiatorAgentDid,
        responderAgentDid: consumedPairingCode.responderAgentDid,
      },
      201,
    );
  };
}
