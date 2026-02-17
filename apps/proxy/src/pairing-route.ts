import { parseDid } from "@clawdentity/protocol";
import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import {
  DEFAULT_PAIRING_TICKET_TTL_SECONDS,
  MAX_PAIRING_TICKET_TTL_SECONDS,
  OWNER_PAT_HEADER,
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
} from "./pairing-constants.js";
import {
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";
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
  issuerProxyUrl?: string;
};

export type PairConfirmRuntimeOptions = {
  fetchImpl?: typeof fetch;
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

function parseTtlSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PAIRING_TICKET_TTL_SECONDS;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: "ttlSeconds must be an integer",
      status: 400,
      expose: true,
    });
  }

  if (value < 1 || value > MAX_PAIRING_TICKET_TTL_SECONDS) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `ttlSeconds must be between 1 and ${MAX_PAIRING_TICKET_TTL_SECONDS}`,
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

async function parseRawJsonBody(c: PairingRouteContext): Promise<{
  rawBody: string;
  json: unknown;
}> {
  const rawBody = await c.req.raw.clone().text();

  try {
    return {
      rawBody,
      json: JSON.parse(rawBody) as unknown,
    };
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

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toPairingStoreAppError(error: unknown): AppError {
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

function extractErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  return typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : undefined;
}

function normalizeProxyOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin;
}

function normalizeHostName(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

function parseIpv4Literal(
  hostname: string,
): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }

    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }

    bytes.push(value);
  }

  return bytes as [number, number, number, number];
}

function isBlockedIpv4Literal(hostname: string): boolean {
  const ipv4 = parseIpv4Literal(hostname);
  if (ipv4 === null) {
    return false;
  }

  const [a, b, c, d] = ipv4;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 18) return true;
  if (a === 198 && b === 19) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;

  return false;
}

function parseIpv6Literal(hostname: string): number[] | null {
  const raw =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const noZoneId = raw.split("%")[0] ?? raw;
  if (!noZoneId.includes(":")) {
    return null;
  }

  const parts = noZoneId.split("::");
  if (parts.length > 2) {
    return null;
  }

  const parseGroupList = (value: string): number[] | null => {
    if (value.length === 0) {
      return [];
    }

    const groups = value.split(":");
    const words: number[] = [];
    for (const group of groups) {
      if (
        group.length === 0 ||
        group.length > 4 ||
        !/^[0-9a-f]+$/i.test(group)
      ) {
        return null;
      }

      words.push(Number.parseInt(group, 16));
    }

    return words;
  };

  const left = parseGroupList(parts[0] ?? "");
  const right = parseGroupList(parts[1] ?? "");
  if (left === null || right === null) {
    return null;
  }

  if (parts.length === 1) {
    if (left.length !== 8) {
      return null;
    }

    return left;
  }

  const missing = 8 - (left.length + right.length);
  if (missing < 1) {
    return null;
  }

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6Literal(hostname: string): boolean {
  const ipv6 = parseIpv6Literal(hostname);
  if (ipv6 === null) {
    return false;
  }

  const [a, b, c, d, e, f, g, h] = ipv6;

  const isUnspecified =
    a === 0 &&
    b === 0 &&
    c === 0 &&
    d === 0 &&
    e === 0 &&
    f === 0 &&
    g === 0 &&
    h === 0;
  if (isUnspecified) {
    return true;
  }

  const isLoopback =
    a === 0 &&
    b === 0 &&
    c === 0 &&
    d === 0 &&
    e === 0 &&
    f === 0 &&
    g === 0 &&
    h === 1;
  if (isLoopback) {
    return true;
  }

  if ((a & 0xfe00) === 0xfc00) {
    return true;
  }

  if ((a & 0xffc0) === 0xfe80) {
    return true;
  }

  if ((a & 0xff00) === 0xff00) {
    return true;
  }

  if (a === 0x2001 && b === 0x0db8) {
    return true;
  }

  const isIpv4Mapped =
    a === 0 &&
    b === 0 &&
    c === 0 &&
    d === 0 &&
    e === 0 &&
    (f === 0xffff || f === 0);

  if (isIpv4Mapped) {
    const mappedA = g >> 8;
    const mappedB = g & 0xff;
    const mappedC = h >> 8;
    const mappedD = h & 0xff;
    return isBlockedIpv4Literal(`${mappedA}.${mappedB}.${mappedC}.${mappedD}`);
  }

  return false;
}

function isLocalLikeHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }

  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return true;
  }

  if (!hostname.includes(".") && parseIpv4Literal(hostname) === null) {
    return true;
  }

  return false;
}

function isBlockedForwardOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  const hostname = normalizeHostName(parsed.hostname);

  if (isLocalLikeHostname(hostname)) {
    return true;
  }

  if (isBlockedIpv4Literal(hostname)) {
    return true;
  }

  if (isBlockedIpv6Literal(hostname)) {
    return true;
  }

  return false;
}

function mapForwardedPairConfirmError(
  status: number,
  payload: unknown,
): AppError {
  const code = extractErrorCode(payload) ?? "PROXY_PAIR_CONFIRM_FAILED";
  const message =
    extractErrorMessage(payload) ??
    (status >= 500
      ? "Issuer proxy pairing service is unavailable"
      : "Issuer proxy rejected pairing confirm");

  return new AppError({
    code,
    message,
    status,
    expose: true,
  });
}

function parsePairConfirmResponse(payload: unknown): {
  paired: true;
  initiatorAgentDid: string;
  responderAgentDid: string;
} {
  if (typeof payload !== "object" || payload === null) {
    throw new AppError({
      code: "PROXY_PAIR_CONFIRM_INVALID_RESPONSE",
      message: "Issuer proxy response is invalid",
      status: 502,
      expose: true,
    });
  }

  const paired = (payload as { paired?: unknown }).paired === true;
  const initiatorRaw = (payload as { initiatorAgentDid?: unknown })
    .initiatorAgentDid;
  const responderRaw = (payload as { responderAgentDid?: unknown })
    .responderAgentDid;
  const initiatorAgentDid =
    typeof initiatorRaw === "string" ? initiatorRaw : "";
  const responderAgentDid =
    typeof responderRaw === "string" ? responderRaw : "";

  if (!paired) {
    throw new AppError({
      code: "PROXY_PAIR_CONFIRM_INVALID_RESPONSE",
      message: "Issuer proxy response is invalid",
      status: 502,
      expose: true,
    });
  }

  try {
    if (parseDid(initiatorAgentDid).kind !== "agent") {
      throw new Error("invalid");
    }
    if (parseDid(responderAgentDid).kind !== "agent") {
      throw new Error("invalid");
    }
  } catch {
    throw new AppError({
      code: "PROXY_PAIR_CONFIRM_INVALID_RESPONSE",
      message: "Issuer proxy response is invalid",
      status: 502,
      expose: true,
    });
  }

  return {
    paired: true,
    initiatorAgentDid,
    responderAgentDid,
  };
}

export function createPairStartHandler(
  options: CreatePairStartHandlerOptions,
): (c: PairingRouteContext) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;
  const registryUrl = normalizeRegistryUrl(options.registryUrl);
  const configuredIssuerProxyUrl =
    typeof options.issuerProxyUrl === "string"
      ? normalizeProxyOrigin(options.issuerProxyUrl)
      : undefined;

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
      ttlSeconds?: unknown;
    };

    const ttlSeconds = parseTtlSeconds(body.ttlSeconds);
    const ownerPat = parseOwnerPatHeader(c.req.header(OWNER_PAT_HEADER));

    await assertPatOwnsInitiatorAgent({
      fetchImpl,
      initiatorAgentDid: auth.agentDid,
      ownerPat,
      registryUrl,
    });

    const issuerProxyUrl =
      configuredIssuerProxyUrl ?? normalizeProxyOrigin(c.req.url);
    const pairingTicketResult = await options.trustStore
      .createPairingTicket({
        initiatorAgentDid: auth.agentDid,
        issuerProxyUrl,
        ttlSeconds,
        nowMs: nowMs(),
      })
      .catch((error: unknown) => {
        throw toPairingStoreAppError(error);
      });

    options.logger.info("proxy.pair.start", {
      requestId: c.get("requestId"),
      initiatorAgentDid: auth.agentDid,
      issuerProxyUrl: pairingTicketResult.issuerProxyUrl,
      expiresAt: new Date(pairingTicketResult.expiresAtMs).toISOString(),
    });

    return c.json({
      initiatorAgentDid: pairingTicketResult.initiatorAgentDid,
      ticket: pairingTicketResult.ticket,
      expiresAt: new Date(pairingTicketResult.expiresAtMs).toISOString(),
    });
  };
}

export function createPairConfirmHandler(
  options: CreatePairConfirmHandlerOptions,
): (c: PairingRouteContext) => Promise<Response> {
  const nowMs = options.nowMs ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (c) => {
    const auth = c.get("auth");
    if (auth === undefined) {
      throw new AppError({
        code: "PROXY_PAIR_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const parsedBody = await parseRawJsonBody(c);
    const body = parsedBody.json as {
      ticket?: unknown;
    };

    if (typeof body.ticket !== "string" || body.ticket.trim() === "") {
      throw new AppError({
        code: "PROXY_PAIR_INVALID_BODY",
        message: "ticket is required",
        status: 400,
        expose: true,
      });
    }

    const ticket = body.ticket.trim();

    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(ticket);
    } catch (error) {
      if (error instanceof PairingTicketParseError) {
        throw new AppError({
          code: error.code,
          message: error.message,
          status: 400,
          expose: true,
        });
      }

      throw new AppError({
        code: "PROXY_PAIR_TICKET_INVALID_FORMAT",
        message: "Pairing ticket format is invalid",
        status: 400,
        expose: true,
      });
    }

    const localProxyOrigin = normalizeProxyOrigin(c.req.url);
    const ticketIssuerOrigin = normalizeProxyOrigin(parsedTicket.iss);
    const isIssuerLocal = ticketIssuerOrigin === localProxyOrigin;

    if (!isIssuerLocal) {
      const localProxyAllowsPrivateForwarding =
        isBlockedForwardOrigin(localProxyOrigin);

      if (
        !localProxyAllowsPrivateForwarding &&
        isBlockedForwardOrigin(ticketIssuerOrigin)
      ) {
        throw new AppError({
          code: "PROXY_PAIR_TICKET_ISSUER_BLOCKED",
          message: "Pairing ticket issuer origin is blocked",
          status: 403,
          expose: true,
        });
      }

      const issuerConfirmUrl = new URL(
        PAIR_CONFIRM_PATH,
        ticketIssuerOrigin.endsWith("/")
          ? ticketIssuerOrigin
          : `${ticketIssuerOrigin}/`,
      ).toString();

      const forwardedResponse = await fetchImpl(issuerConfirmUrl, {
        method: "POST",
        headers: c.req.raw.headers,
        body: parsedBody.rawBody,
      }).catch((error: unknown) => {
        throw new AppError({
          code: "PROXY_PAIR_STATE_UNAVAILABLE",
          message: "Issuer proxy pairing service is unavailable",
          status: 503,
          details: {
            reason: error instanceof Error ? error.message : "unknown",
          },
          expose: true,
        });
      });

      const forwardedBody = await parseJsonResponse(forwardedResponse);
      if (!forwardedResponse.ok) {
        throw mapForwardedPairConfirmError(
          forwardedResponse.status,
          forwardedBody,
        );
      }

      const confirmed = parsePairConfirmResponse(forwardedBody);
      if (confirmed.responderAgentDid !== auth.agentDid) {
        throw new AppError({
          code: "PROXY_PAIR_CONFIRM_RESPONDER_MISMATCH",
          message: "Issuer proxy response did not match caller responder DID",
          status: 502,
          expose: true,
        });
      }

      await options.trustStore
        .upsertPair({
          initiatorAgentDid: confirmed.initiatorAgentDid,
          responderAgentDid: confirmed.responderAgentDid,
        })
        .catch((error: unknown) => {
          throw toPairingStoreAppError(error);
        });

      options.logger.info("proxy.pair.confirm.forwarded", {
        requestId: c.get("requestId"),
        initiatorAgentDid: confirmed.initiatorAgentDid,
        responderAgentDid: confirmed.responderAgentDid,
        issuerProxyUrl: ticketIssuerOrigin,
      });

      return c.json(
        {
          paired: true,
          initiatorAgentDid: confirmed.initiatorAgentDid,
          responderAgentDid: confirmed.responderAgentDid,
        },
        201,
      );
    }

    const confirmedPairingTicket = await options.trustStore
      .confirmPairingTicket({
        ticket,
        responderAgentDid: auth.agentDid,
        nowMs: nowMs(),
      })
      .catch((error: unknown) => {
        throw toPairingStoreAppError(error);
      });

    options.logger.info("proxy.pair.confirm", {
      requestId: c.get("requestId"),
      initiatorAgentDid: confirmedPairingTicket.initiatorAgentDid,
      responderAgentDid: confirmedPairingTicket.responderAgentDid,
      issuerProxyUrl: confirmedPairingTicket.issuerProxyUrl,
    });

    return c.json(
      {
        paired: true,
        initiatorAgentDid: confirmedPairingTicket.initiatorAgentDid,
        responderAgentDid: confirmedPairingTicket.responderAgentDid,
      },
      201,
    );
  };
}
