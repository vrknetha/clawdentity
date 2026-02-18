import { PROXY_TRUST_DO_NAME } from "./pairing-constants.js";
import {
  createPairingTicket,
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";

export type PairingTicketInput = {
  initiatorAgentDid: string;
  issuerProxyUrl: string;
  ttlSeconds: number;
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
      expiresAtMs: number;
      initiatorAgentDid: string;
      issuerProxyUrl: string;
    }
  >();

  function cleanup(nowMs: number, skipTicket?: string): void {
    for (const [ticket, details] of pairingTickets.entries()) {
      if (skipTicket === ticket) {
        continue;
      }

      if (details.expiresAtMs <= nowMs) {
        pairingTickets.delete(ticket);
      }
    }
  }

  function upsertPeer(leftAgentDid: string, rightAgentDid: string): void {
    const peers = agentPeers.get(leftAgentDid) ?? new Set<string>();
    peers.add(rightAgentDid);
    agentPeers.set(leftAgentDid, peers);
  }

  function resolveConfirmablePairingTicket(
    input: PairingTicketConfirmInput,
  ): PairingTicketConfirmResult {
    const nowMs = input.nowMs ?? Date.now();
    cleanup(nowMs, input.ticket);

    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(input.ticket);
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

    const stored = pairingTickets.get(input.ticket);
    if (!stored) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
      pairingTickets.delete(input.ticket);
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
      initiatorAgentDid: stored.initiatorAgentDid,
      responderAgentDid: input.responderAgentDid,
      issuerProxyUrl: stored.issuerProxyUrl,
    };
  }

  return {
    async createPairingTicket(input) {
      const nowMs = input.nowMs ?? Date.now();
      cleanup(nowMs);

      const expiresAtMs = nowMs + input.ttlSeconds * 1000;
      const created = createPairingTicket({
        issuerProxyUrl: input.issuerProxyUrl,
        expiresAtMs,
        nowMs,
      });

      pairingTickets.set(created.ticket, {
        initiatorAgentDid: input.initiatorAgentDid,
        issuerProxyUrl: created.payload.iss,
        expiresAtMs,
      });

      return {
        ticket: created.ticket,
        expiresAtMs,
        initiatorAgentDid: input.initiatorAgentDid,
        issuerProxyUrl: created.payload.iss,
      };
    },
    async confirmPairingTicket(input) {
      const confirmedPair = resolveConfirmablePairingTicket(input);
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
      pairingTickets.delete(input.ticket);
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
