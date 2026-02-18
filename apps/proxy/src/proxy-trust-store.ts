import { PROXY_TRUST_DO_NAME } from "./pairing-constants.js";
import {
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";

export type PairingTicketInput = {
  initiatorAgentDid: string;
  issuerProxyUrl: string;
  ticket: string;
  expiresAtMs: number;
  nowMs?: number;
};

export type PairingTicketResult = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  issuerProxyUrl: string;
};

export type PairingTicketConfirmInput = {
  ticket: string;
  responderAgentDid: string;
  nowMs?: number;
};

export type PairingTicketConfirmResult = {
  initiatorAgentDid: string;
  responderAgentDid: string;
  issuerProxyUrl: string;
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
  isAgentKnown: "/agents/known",
  isPairAllowed: "/pairs/check",
  upsertPair: "/pairs/upsert",
} as const;

function toPairKey(
  initiatorAgentDid: string,
  responderAgentDid: string,
): string {
  return [initiatorAgentDid, responderAgentDid].sort().join("|");
}

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
      return callDurableState<PairingTicketResult>(
        namespace,
        TRUST_STORE_ROUTES.createPairingTicket,
        input,
      );
    },
    async confirmPairingTicket(input) {
      return callDurableState<PairingTicketConfirmResult>(
        namespace,
        TRUST_STORE_ROUTES.confirmPairingTicket,
        input,
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
  const pairingTickets = new Map<
    string,
    {
      ticket: string;
      expiresAtMs: number;
      initiatorAgentDid: string;
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
  } {
    const nowMs = input.nowMs ?? Date.now();
    const parsedTicket = parseStoredTicket(input.ticket);
    cleanup(nowMs, parsedTicket.kid);

    const stored = pairingTickets.get(parsedTicket.kid);
    if (!stored || stored.ticket !== input.ticket) {
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
        responderAgentDid: input.responderAgentDid,
        issuerProxyUrl: stored.issuerProxyUrl,
      },
      ticketKid: parsedTicket.kid,
    };
  }

  return {
    async createPairingTicket(input) {
      const nowMs = input.nowMs ?? Date.now();
      cleanup(nowMs);

      const parsedTicket = parseStoredTicket(input.ticket);

      if (parsedTicket.iss !== input.issuerProxyUrl) {
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_TICKET_INVALID_ISSUER",
          message: "Pairing ticket issuer URL is invalid",
          status: 400,
        });
      }

      if (parsedTicket.exp * 1000 !== input.expiresAtMs) {
        throw new ProxyTrustStoreError({
          code: "PROXY_PAIR_START_INVALID_BODY",
          message: "Pairing ticket expiry is invalid",
          status: 400,
        });
      }

      pairingTickets.set(parsedTicket.kid, {
        ticket: input.ticket,
        initiatorAgentDid: input.initiatorAgentDid,
        issuerProxyUrl: parsedTicket.iss,
        expiresAtMs: input.expiresAtMs,
      });

      return {
        ticket: input.ticket,
        expiresAtMs: input.expiresAtMs,
        initiatorAgentDid: input.initiatorAgentDid,
        issuerProxyUrl: parsedTicket.iss,
      };
    },
    async confirmPairingTicket(input) {
      const { pair: confirmedPair, ticketKid } =
        resolveConfirmablePairingTicket(input);
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
      return confirmedPair;
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
