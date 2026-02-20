import { PROXY_TRUST_DO_NAME } from "./pairing-constants.js";
import {
  normalizePairingTicketText,
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";
import { normalizeExpiryToWholeSecond, toPairKey } from "./proxy-trust-keys.js";

export type PairingTicketInput = {
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  initiatorE2ee: PeerE2eeBundle;
  issuerProxyUrl: string;
  ticket: string;
  expiresAtMs: number;
  nowMs?: number;
};

export type PairingTicketResult = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  initiatorE2ee: PeerE2eeBundle;
  issuerProxyUrl: string;
};

export type PairingTicketConfirmInput = {
  ticket: string;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  responderE2ee: PeerE2eeBundle;
  nowMs?: number;
};

export type PairingTicketConfirmResult = {
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  initiatorE2ee: PeerE2eeBundle;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  responderE2ee: PeerE2eeBundle;
  issuerProxyUrl: string;
};

export type PairingTicketStatusInput = {
  ticket: string;
  nowMs?: number;
};

export type PairingTicketStatusResult =
  | {
      status: "pending";
      ticket: string;
      initiatorAgentDid: string;
      initiatorProfile: PeerProfile;
      initiatorE2ee: PeerE2eeBundle;
      issuerProxyUrl: string;
      expiresAtMs: number;
    }
  | {
      status: "confirmed";
      ticket: string;
      initiatorAgentDid: string;
      initiatorProfile: PeerProfile;
      initiatorE2ee: PeerE2eeBundle;
      responderAgentDid: string;
      responderProfile: PeerProfile;
      responderE2ee: PeerE2eeBundle;
      issuerProxyUrl: string;
      expiresAtMs: number;
      confirmedAtMs: number;
    };

export type PeerProfile = {
  agentName: string;
  humanName: string;
};

export type PeerE2eeBundle = {
  keyId: string;
  x25519PublicKey: string;
};

export type PairingInput = {
  initiatorAgentDid: string;
  responderAgentDid: string;
};

export interface ProxyTrustStore {
  createPairingTicket(input: PairingTicketInput): Promise<PairingTicketResult>;
  confirmPairingTicket(
    input: PairingTicketConfirmInput,
  ): Promise<PairingTicketConfirmResult>;
  getPairingTicketStatus(
    input: PairingTicketStatusInput,
  ): Promise<PairingTicketStatusResult>;
  isAgentKnown(agentDid: string): Promise<boolean>;
  isPairAllowed(input: PairingInput): Promise<boolean>;
  upsertPair(input: PairingInput): Promise<void>;
}

export type ProxyTrustStateStub = {
  fetch(request: Request): Promise<Response>;
};

export type ProxyTrustStateNamespace = {
  get: (id: DurableObjectId) => ProxyTrustStateStub;
  idFromName: (name: string) => DurableObjectId;
};

export class ProxyTrustStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(input: { code: string; message: string; status: number }) {
    super(input.message);
    this.name = "ProxyTrustStoreError";
    this.code = input.code;
    this.status = input.status;
  }
}

export const TRUST_STORE_ROUTES = {
  createPairingTicket: "/pairing-tickets/create",
  confirmPairingTicket: "/pairing-tickets/confirm",
  getPairingTicketStatus: "/pairing-tickets/status",
  isAgentKnown: "/agents/known",
  isPairAllowed: "/pairs/check",
  upsertPair: "/pairs/upsert",
} as const;

function parseErrorPayload(payload: unknown): {
  code: string;
  message: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return {
      code: "PROXY_TRUST_STATE_ERROR",
      message: "Trust state operation failed",
    };
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {
      code: "PROXY_TRUST_STATE_ERROR",
      message: "Trust state operation failed",
    };
  }

  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "PROXY_TRUST_STATE_ERROR";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Trust state operation failed";

  return { code, message };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function createDurableObjectRequest(path: string, payload: unknown): Request {
  return new Request(`https://proxy-trust-state${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function resolveDurableStateStub(
  namespace: ProxyTrustStateNamespace,
): ProxyTrustStateStub {
  return namespace.get(namespace.idFromName(PROXY_TRUST_DO_NAME));
}

async function callDurableState<T>(
  namespace: ProxyTrustStateNamespace,
  path: string,
  payload: unknown,
): Promise<T> {
  const stub = resolveDurableStateStub(namespace);
  const response = await stub.fetch(createDurableObjectRequest(path, payload));
  if (!response.ok) {
    const parsed = parseErrorPayload(await parseJsonResponse(response));
    throw new ProxyTrustStoreError({
      code: parsed.code,
      message: parsed.message,
      status: response.status,
    });
  }

  return (await response.json()) as T;
}

export function createDurableProxyTrustStore(
  namespace: ProxyTrustStateNamespace,
): ProxyTrustStore {
  return {
    async createPairingTicket(input) {
      const ticket = normalizePairingTicketText(input.ticket);
      return callDurableState<PairingTicketResult>(
        namespace,
        TRUST_STORE_ROUTES.createPairingTicket,
        { ...input, ticket },
      );
    },
    async confirmPairingTicket(input) {
      const ticket = normalizePairingTicketText(input.ticket);
      return callDurableState<PairingTicketConfirmResult>(
        namespace,
        TRUST_STORE_ROUTES.confirmPairingTicket,
        { ...input, ticket },
      );
    },
    async getPairingTicketStatus(input) {
      const ticket = normalizePairingTicketText(input.ticket);
      return callDurableState<PairingTicketStatusResult>(
        namespace,
        TRUST_STORE_ROUTES.getPairingTicketStatus,
        { ...input, ticket },
      );
    },
    async isAgentKnown(agentDid) {
      const result = await callDurableState<{ known: boolean }>(
        namespace,
        TRUST_STORE_ROUTES.isAgentKnown,
        { agentDid },
      );
      return result.known;
    },
    async isPairAllowed(input) {
      const result = await callDurableState<{ allowed: boolean }>(
        namespace,
        TRUST_STORE_ROUTES.isPairAllowed,
        input,
      );
      return result.allowed;
    },
    async upsertPair(input) {
      await callDurableState<{ ok: true }>(
        namespace,
        TRUST_STORE_ROUTES.upsertPair,
        input,
      );
    },
  };
}

export function createInMemoryProxyTrustStore(): ProxyTrustStore {
  const pairKeys = new Set<string>();
  const agentPeers = new Map<string, Set<string>>();
  const confirmedPairingTickets = new Map<
    string,
    {
      ticket: string;
      expiresAtMs: number;
      initiatorAgentDid: string;
      initiatorProfile: PeerProfile;
      initiatorE2ee: PeerE2eeBundle;
      responderAgentDid: string;
      responderProfile: PeerProfile;
      responderE2ee: PeerE2eeBundle;
      issuerProxyUrl: string;
      confirmedAtMs: number;
    }
  >();
  const pairingTickets = new Map<
    string,
    {
      ticket: string;
      expiresAtMs: number;
      initiatorAgentDid: string;
      initiatorProfile: PeerProfile;
      initiatorE2ee: PeerE2eeBundle;
      issuerProxyUrl: string;
    }
  >();

  function cleanup(nowMs: number, skipTicketKid?: string): void {
    for (const [ticketKid, details] of pairingTickets.entries()) {
      if (skipTicketKid === ticketKid) {
        continue;
      }

      if (details.expiresAtMs <= nowMs) {
        pairingTickets.delete(ticketKid);
      }
    }

    for (const [ticketKid, details] of confirmedPairingTickets.entries()) {
      if (skipTicketKid === ticketKid) {
        continue;
      }

      if (details.expiresAtMs <= nowMs) {
        confirmedPairingTickets.delete(ticketKid);
      }
    }
  }

  function upsertPeer(leftAgentDid: string, rightAgentDid: string): void {
    const peers = agentPeers.get(leftAgentDid) ?? new Set<string>();
    peers.add(rightAgentDid);
    agentPeers.set(leftAgentDid, peers);
  }

  function parseStoredTicket(
    inputTicket: string,
  ): ReturnType<typeof parsePairingTicket> {
    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(inputTicket);
    } catch (error) {
      if (error instanceof PairingTicketParseError) {
        throw new ProxyTrustStoreError({
          code: error.code,
          message: error.message,
          status: 400,
        });
      }

      throw error;
    }

    return parsedTicket;
  }

  function resolveConfirmablePairingTicket(input: PairingTicketConfirmInput): {
    pair: PairingTicketConfirmResult;
    ticketKid: string;
    expiresAtMs: number;
  } {
    const nowMs = input.nowMs ?? Date.now();
    const normalizedTicket = normalizePairingTicketText(input.ticket);
    const parsedTicket = parseStoredTicket(normalizedTicket);
    cleanup(nowMs, parsedTicket.kid);

    const stored = pairingTickets.get(parsedTicket.kid);
    if (!stored || stored.ticket !== normalizedTicket) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
      pairingTickets.delete(parsedTicket.kid);
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_TICKET_EXPIRED",
        message: "Pairing ticket has expired",
        status: 410,
      });
    }

    if (stored.issuerProxyUrl !== parsedTicket.iss) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_TICKET_INVALID_ISSUER",
        message: "Pairing ticket issuer URL is invalid",
        status: 400,
      });
    }

    return {
      pair: {
        initiatorAgentDid: stored.initiatorAgentDid,
        initiatorProfile: stored.initiatorProfile,
        initiatorE2ee: stored.initiatorE2ee,
        responderAgentDid: input.responderAgentDid,
        responderProfile: input.responderProfile,
        responderE2ee: input.responderE2ee,
        issuerProxyUrl: stored.issuerProxyUrl,
      },
      ticketKid: parsedTicket.kid,
      expiresAtMs: stored.expiresAtMs,
    };
  }

  function resolveTicketStatus(
    input: PairingTicketStatusInput,
  ): PairingTicketStatusResult {
    const nowMs = input.nowMs ?? Date.now();
    const normalizedTicket = normalizePairingTicketText(input.ticket);
    const parsedTicket = parseStoredTicket(normalizedTicket);
    cleanup(nowMs, parsedTicket.kid);

    const pending = pairingTickets.get(parsedTicket.kid);
    if (pending && pending.ticket === normalizedTicket) {
      if (pending.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
        pairingTickets.delete(parsedTicket.kid);
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_TICKET_EXPIRED",
          message: "Pairing ticket has expired",
          status: 410,
        });
      }

      return {
        status: "pending",
        ticket: pending.ticket,
        initiatorAgentDid: pending.initiatorAgentDid,
        initiatorProfile: pending.initiatorProfile,
        initiatorE2ee: pending.initiatorE2ee,
        issuerProxyUrl: pending.issuerProxyUrl,
        expiresAtMs: pending.expiresAtMs,
      };
    }

    const confirmed = confirmedPairingTickets.get(parsedTicket.kid);
    if (confirmed && confirmed.ticket === normalizedTicket) {
      if (confirmed.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
        confirmedPairingTickets.delete(parsedTicket.kid);
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_TICKET_EXPIRED",
          message: "Pairing ticket has expired",
          status: 410,
        });
      }

      return {
        status: "confirmed",
        ticket: confirmed.ticket,
        initiatorAgentDid: confirmed.initiatorAgentDid,
        initiatorProfile: confirmed.initiatorProfile,
        initiatorE2ee: confirmed.initiatorE2ee,
        responderAgentDid: confirmed.responderAgentDid,
        responderProfile: confirmed.responderProfile,
        responderE2ee: confirmed.responderE2ee,
        issuerProxyUrl: confirmed.issuerProxyUrl,
        expiresAtMs: confirmed.expiresAtMs,
        confirmedAtMs: confirmed.confirmedAtMs,
      };
    }

    if (parsedTicket.exp * 1000 <= nowMs) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_TICKET_EXPIRED",
        message: "Pairing ticket has expired",
        status: 410,
      });
    }

    throw new ProxyTrustStoreError({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      message: "Pairing ticket not found",
      status: 404,
    });
  }

  return {
    async createPairingTicket(input) {
      const nowMs = input.nowMs ?? Date.now();
      cleanup(nowMs);

      const ticket = normalizePairingTicketText(input.ticket);
      const parsedTicket = parseStoredTicket(ticket);
      const normalizedExpiresAtMs = normalizeExpiryToWholeSecond(
        input.expiresAtMs,
      );

      if (parsedTicket.iss !== input.issuerProxyUrl) {
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_TICKET_INVALID_ISSUER",
          message: "Pairing ticket issuer URL is invalid",
          status: 400,
        });
      }

      if (parsedTicket.exp * 1000 !== normalizedExpiresAtMs) {
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_START_INVALID_BODY",
          message: "Pairing ticket expiry is invalid",
          status: 400,
        });
      }

      pairingTickets.set(parsedTicket.kid, {
        ticket,
        initiatorAgentDid: input.initiatorAgentDid,
        initiatorProfile: input.initiatorProfile,
        initiatorE2ee: input.initiatorE2ee,
        issuerProxyUrl: parsedTicket.iss,
        expiresAtMs: normalizedExpiresAtMs,
      });
      confirmedPairingTickets.delete(parsedTicket.kid);

      return {
        ticket,
        expiresAtMs: normalizedExpiresAtMs,
        initiatorAgentDid: input.initiatorAgentDid,
        initiatorProfile: input.initiatorProfile,
        initiatorE2ee: input.initiatorE2ee,
        issuerProxyUrl: parsedTicket.iss,
      };
    },
    async confirmPairingTicket(input) {
      const {
        pair: confirmedPair,
        ticketKid,
        expiresAtMs,
      } = resolveConfirmablePairingTicket(input);
      const confirmedAtMs = normalizeExpiryToWholeSecond(
        input.nowMs ?? Date.now(),
      );
      pairKeys.add(
        toPairKey(
          confirmedPair.initiatorAgentDid,
          confirmedPair.responderAgentDid,
        ),
      );
      upsertPeer(
        confirmedPair.initiatorAgentDid,
        confirmedPair.responderAgentDid,
      );
      upsertPeer(
        confirmedPair.responderAgentDid,
        confirmedPair.initiatorAgentDid,
      );
      pairingTickets.delete(ticketKid);
      const ticket = normalizePairingTicketText(input.ticket);
      confirmedPairingTickets.set(ticketKid, {
        ticket,
        initiatorAgentDid: confirmedPair.initiatorAgentDid,
        initiatorProfile: confirmedPair.initiatorProfile,
        initiatorE2ee: confirmedPair.initiatorE2ee,
        responderAgentDid: confirmedPair.responderAgentDid,
        responderProfile: confirmedPair.responderProfile,
        responderE2ee: confirmedPair.responderE2ee,
        issuerProxyUrl: confirmedPair.issuerProxyUrl,
        expiresAtMs,
        confirmedAtMs,
      });
      return confirmedPair;
    },
    async getPairingTicketStatus(input) {
      return resolveTicketStatus(input);
    },
    async isAgentKnown(agentDid) {
      return (agentPeers.get(agentDid)?.size ?? 0) > 0;
    },
    async isPairAllowed(input) {
      if (input.initiatorAgentDid === input.responderAgentDid) {
        return true;
      }

      return pairKeys.has(
        toPairKey(input.initiatorAgentDid, input.responderAgentDid),
      );
    },
    async upsertPair(input) {
      pairKeys.add(toPairKey(input.initiatorAgentDid, input.responderAgentDid));
      upsertPeer(input.initiatorAgentDid, input.responderAgentDid);
      upsertPeer(input.responderAgentDid, input.initiatorAgentDid);
    },
  };
}
