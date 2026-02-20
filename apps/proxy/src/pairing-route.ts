import { decodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  createRegistryIdentityClient,
  type Logger,
} from "@clawdentity/sdk";
import type { Context } from "hono";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import {
  DEFAULT_PAIRING_TICKET_TTL_SECONDS,
  MAX_PAIRING_TICKET_TTL_SECONDS,
  PAIR_CONFIRM_PATH,
  PAIR_START_PATH,
  PAIR_STATUS_PATH,
} from "./pairing-constants.js";
import {
  createPairingTicket,
  createPairingTicketSigningKey,
  normalizePairingTicketText,
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";
import {
  type PeerE2eeBundle,
  type PeerProfile,
  type ProxyTrustStore,
  ProxyTrustStoreError,
} from "./proxy-trust-store.js";

export { PAIR_CONFIRM_PATH, PAIR_START_PATH };
export { PAIR_STATUS_PATH };

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
  registryInternalServiceId?: string;
  registryInternalServiceSecret?: string;
};

export type PairConfirmRuntimeOptions = {
  nowMs?: () => number;
};

type CreatePairConfirmHandlerOptions = PairConfirmRuntimeOptions & {
  logger: Logger;
  trustStore: ProxyTrustStore;
};

export type PairStatusRuntimeOptions = {
  nowMs?: () => number;
};

type CreatePairStatusHandlerOptions = PairStatusRuntimeOptions & {
  logger: Logger;
  trustStore: ProxyTrustStore;
};

const MAX_PROFILE_NAME_LENGTH = 64;
const X25519_PUBLIC_KEY_BYTES = 32;

function parseInternalServiceCredentials(input: {
  serviceId?: string;
  serviceSecret?: string;
}): { serviceId: string; serviceSecret: string } {
  const serviceId =
    typeof input.serviceId === "string" ? input.serviceId.trim() : "";
  const serviceSecret =
    typeof input.serviceSecret === "string" ? input.serviceSecret.trim() : "";
  if (serviceId.length === 0 || serviceSecret.length === 0) {
    throw new AppError({
      code: "PROXY_INTERNAL_AUTH_CONFIG_INVALID",
      message: "Proxy internal service auth is not configured",
      status: 500,
    });
  }

  return {
    serviceId,
    serviceSecret,
  };
}

function normalizeRegistryUrl(registryUrl: string): string {
  const baseUrl = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return new URL(baseUrl).toString();
}

function normalizeProxyOrigin(value: string): string {
  return new URL(value).origin;
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

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

function parseProfileName(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} is required`,
      status: 400,
      expose: true,
    });
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} is required`,
      status: 400,
      expose: true,
    });
  }

  if (normalized.length > MAX_PROFILE_NAME_LENGTH) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} must be at most ${MAX_PROFILE_NAME_LENGTH} characters`,
      status: 400,
      expose: true,
    });
  }

  if (hasControlChars(normalized)) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} contains control characters`,
      status: 400,
      expose: true,
    });
  }

  return normalized;
}

function parsePeerProfile(value: unknown, label: string): PeerProfile {
  if (typeof value !== "object" || value === null) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} is required`,
      status: 400,
      expose: true,
    });
  }

  const payload = value as { agentName?: unknown; humanName?: unknown };
  return {
    agentName: parseProfileName(payload.agentName, `${label}.agentName`),
    humanName: parseProfileName(payload.humanName, `${label}.humanName`),
  };
}

function parsePeerE2eeBundle(value: unknown, label: string): PeerE2eeBundle {
  if (typeof value !== "object" || value === null) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label} is required`,
      status: 400,
      expose: true,
    });
  }

  const payload = value as { keyId?: unknown; x25519PublicKey?: unknown };
  const keyId = parseProfileName(payload.keyId, `${label}.keyId`);
  const x25519PublicKey = parseProfileName(
    payload.x25519PublicKey,
    `${label}.x25519PublicKey`,
  );

  let decodedPublicKey: Uint8Array;
  try {
    decodedPublicKey = decodeBase64url(x25519PublicKey);
  } catch {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label}.x25519PublicKey must be valid base64url`,
      status: 400,
      expose: true,
    });
  }

  if (decodedPublicKey.length !== X25519_PUBLIC_KEY_BYTES) {
    throw new AppError({
      code: "PROXY_PAIR_INVALID_BODY",
      message: `${label}.x25519PublicKey must decode to ${X25519_PUBLIC_KEY_BYTES} bytes`,
      status: 400,
      expose: true,
    });
  }

  return {
    keyId,
    x25519PublicKey,
  };
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

async function assertCallerOwnsInitiatorAgent(input: {
  initiatorAgentDid: string;
  ownerDid: string;
  registryUrl: string;
  registryInternalServiceId: string;
  registryInternalServiceSecret: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const identityClient = createRegistryIdentityClient({
    registryUrl: input.registryUrl,
    serviceId: input.registryInternalServiceId,
    serviceSecret: input.registryInternalServiceSecret,
    fetchImpl: input.fetchImpl,
  });

  let result: {
    ownsAgent: boolean;
    agentStatus: "active" | "revoked" | null;
  };
  try {
    result = await identityClient.checkAgentOwnership({
      ownerDid: input.ownerDid,
      agentDid: input.initiatorAgentDid,
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "IDENTITY_SERVICE_UNAUTHORIZED"
    ) {
      throw new AppError({
        code: "PROXY_INTERNAL_AUTH_UNAUTHORIZED",
        message: "Proxy internal service authorization failed",
        status: 503,
        expose: true,
      });
    }

    throw new AppError({
      code: "PROXY_PAIR_OWNERSHIP_UNAVAILABLE",
      message: "Registry owner lookup is unavailable",
      status: 503,
      expose: true,
    });
  }

  if (!result.ownsAgent || result.agentStatus !== "active") {
    throw new AppError({
      code: "PROXY_PAIR_OWNERSHIP_FORBIDDEN",
      message: "Caller does not control initiator agent DID",
      status: 403,
      expose: true,
    });
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
      ttlSeconds?: unknown;
      initiatorProfile?: unknown;
      initiatorE2ee?: unknown;
    };
    const ttlSeconds = parseTtlSeconds(body.ttlSeconds);
    const initiatorProfile = parsePeerProfile(
      body.initiatorProfile,
      "initiatorProfile",
    );
    const initiatorE2ee = parsePeerE2eeBundle(
      body.initiatorE2ee,
      "initiatorE2ee",
    );
    const internalServiceCredentials = parseInternalServiceCredentials({
      serviceId: options.registryInternalServiceId,
      serviceSecret: options.registryInternalServiceSecret,
    });
    await assertCallerOwnsInitiatorAgent({
      fetchImpl,
      initiatorAgentDid: auth.agentDid,
      ownerDid: auth.ownerDid,
      registryUrl,
      registryInternalServiceId: internalServiceCredentials.serviceId,
      registryInternalServiceSecret: internalServiceCredentials.serviceSecret,
    });

    const issuedAtMs = nowMs();
    const requestedExpiresAtMs = issuedAtMs + ttlSeconds * 1000;
    const issuerProxyUrl = normalizeProxyOrigin(c.req.url);

    const signingKey = await createPairingTicketSigningKey({
      nowMs: issuedAtMs,
    }).catch(() => {
      throw new AppError({
        code: "PROXY_PAIR_TICKET_SIGNING_UNAVAILABLE",
        message: "Pairing ticket signing is unavailable",
        status: 503,
        expose: true,
      });
    });

    const createdTicket = await createPairingTicket({
      issuerProxyUrl,
      expiresAtMs: requestedExpiresAtMs,
      nowMs: issuedAtMs,
      signingKey: {
        pkid: signingKey.pkid,
        privateKey: signingKey.privateKey,
      },
    }).catch(() => {
      throw new AppError({
        code: "PROXY_PAIR_TICKET_SIGNING_UNAVAILABLE",
        message: "Pairing ticket signing is unavailable",
        status: 503,
        expose: true,
      });
    });
    const expiresAtMs = createdTicket.payload.exp * 1000;

    const pairingTicketResult = await options.trustStore
      .createPairingTicket({
        initiatorAgentDid: auth.agentDid,
        initiatorProfile,
        initiatorE2ee,
        issuerProxyUrl,
        ticket: createdTicket.ticket,
        expiresAtMs,
        nowMs: issuedAtMs,
      })
      .catch((error: unknown) => {
        throw toPairingStoreAppError(error);
      });

    options.logger.info("proxy.pair.start", {
      requestId: c.get("requestId"),
      initiatorAgentDid: auth.agentDid,
      issuerProxyUrl: pairingTicketResult.issuerProxyUrl,
      expiresAt: new Date(pairingTicketResult.expiresAtMs).toISOString(),
      pkid: signingKey.pkid,
    });

    return c.json({
      initiatorAgentDid: pairingTicketResult.initiatorAgentDid,
      initiatorProfile: pairingTicketResult.initiatorProfile,
      initiatorE2ee: pairingTicketResult.initiatorE2ee,
      ticket: pairingTicketResult.ticket,
      expiresAt: new Date(pairingTicketResult.expiresAtMs).toISOString(),
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
      ticket?: unknown;
      responderProfile?: unknown;
      responderE2ee?: unknown;
    };
    if (typeof body.ticket !== "string" || body.ticket.trim() === "") {
      throw new AppError({
        code: "PROXY_PAIR_INVALID_BODY",
        message: "ticket is required",
        status: 400,
        expose: true,
      });
    }
    const responderProfile = parsePeerProfile(
      body.responderProfile,
      "responderProfile",
    );
    const responderE2ee = parsePeerE2eeBundle(
      body.responderE2ee,
      "responderE2ee",
    );

    const ticket = normalizePairingTicketText(body.ticket);
    try {
      parsePairingTicket(ticket);
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

    const confirmedPairingTicket = await options.trustStore
      .confirmPairingTicket({
        ticket,
        responderAgentDid: auth.agentDid,
        responderProfile,
        responderE2ee,
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
        initiatorProfile: confirmedPairingTicket.initiatorProfile,
        initiatorE2ee: confirmedPairingTicket.initiatorE2ee,
        responderAgentDid: confirmedPairingTicket.responderAgentDid,
        responderProfile: confirmedPairingTicket.responderProfile,
        responderE2ee: confirmedPairingTicket.responderE2ee,
      },
      201,
    );
  };
}

export function createPairStatusHandler(
  options: CreatePairStatusHandlerOptions,
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

    const body = (await parseJsonBody(c)) as { ticket?: unknown };
    if (typeof body.ticket !== "string" || body.ticket.trim() === "") {
      throw new AppError({
        code: "PROXY_PAIR_INVALID_BODY",
        message: "ticket is required",
        status: 400,
        expose: true,
      });
    }

    const ticket = normalizePairingTicketText(body.ticket);
    const status = await options.trustStore
      .getPairingTicketStatus({
        ticket,
        nowMs: nowMs(),
      })
      .catch((error: unknown) => {
        throw toPairingStoreAppError(error);
      });

    const isParticipant =
      auth.agentDid === status.initiatorAgentDid ||
      (status.status === "confirmed" &&
        auth.agentDid === status.responderAgentDid);
    if (!isParticipant) {
      throw new AppError({
        code: "PROXY_PAIR_STATUS_FORBIDDEN",
        message: "Caller is not a participant for this pairing ticket",
        status: 403,
        expose: true,
      });
    }

    options.logger.info("proxy.pair.status", {
      requestId: c.get("requestId"),
      status: status.status,
      initiatorAgentDid: status.initiatorAgentDid,
      initiatorAgentName: status.initiatorProfile.agentName,
      initiatorHumanName: status.initiatorProfile.humanName,
      initiatorE2eeKeyId: status.initiatorE2ee.keyId,
      responderAgentDid:
        status.status === "confirmed" ? status.responderAgentDid : undefined,
      responderAgentName:
        status.status === "confirmed"
          ? status.responderProfile.agentName
          : undefined,
      responderHumanName:
        status.status === "confirmed"
          ? status.responderProfile.humanName
          : undefined,
      responderE2eeKeyId:
        status.status === "confirmed" ? status.responderE2ee.keyId : undefined,
      expiresAt: new Date(status.expiresAtMs).toISOString(),
      confirmedAt:
        status.status === "confirmed"
          ? new Date(status.confirmedAtMs).toISOString()
          : undefined,
    });

    return c.json({
      status: status.status,
      initiatorAgentDid: status.initiatorAgentDid,
      initiatorProfile: status.initiatorProfile,
      initiatorE2ee: status.initiatorE2ee,
      responderAgentDid:
        status.status === "confirmed" ? status.responderAgentDid : undefined,
      responderProfile:
        status.status === "confirmed" ? status.responderProfile : undefined,
      responderE2ee:
        status.status === "confirmed" ? status.responderE2ee : undefined,
      expiresAt: new Date(status.expiresAtMs).toISOString(),
      confirmedAt:
        status.status === "confirmed"
          ? new Date(status.confirmedAtMs).toISOString()
          : undefined,
    });
  };
}
