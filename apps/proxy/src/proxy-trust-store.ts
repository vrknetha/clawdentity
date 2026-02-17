import { generateUlid } from "@clawdentity/protocol";
import { PROXY_TRUST_DO_NAME } from "./pairing-constants.js";

export type PairingCodeInput = {
  initiatorAgentDid: string;
  responderAgentDid: string;
  nowMs?: number;
  ttlSeconds: number;
};

export type PairingCodeResult = {
  pairingCode: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  responderAgentDid: string;
};

export type PairingCodeConsumeInput = {
  pairingCode: string;
  responderAgentDid: string;
  nowMs?: number;
};

export type PairingCodeConsumeResult = {
  initiatorAgentDid: string;
  responderAgentDid: string;
};

export type PairingInput = {
  initiatorAgentDid: string;
  responderAgentDid: string;
};

export interface ProxyTrustStore {
  createPairingCode(input: PairingCodeInput): Promise<PairingCodeResult>;
  consumePairingCode(
    input: PairingCodeConsumeInput,
  ): Promise<PairingCodeConsumeResult>;
  confirmPairingCode(
    input: PairingCodeConsumeInput,
  ): Promise<PairingCodeConsumeResult>;
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
  createPairingCode: "/pairing-codes/create",
  consumePairingCode: "/pairing-codes/consume",
  confirmPairingCode: "/pairing-codes/confirm",
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
    async createPairingCode(input) {
      return callDurableState<PairingCodeResult>(
        namespace,
        TRUST_STORE_ROUTES.createPairingCode,
        input,
      );
    },
    async consumePairingCode(input) {
      return callDurableState<PairingCodeConsumeResult>(
        namespace,
        TRUST_STORE_ROUTES.consumePairingCode,
        input,
      );
    },
    async confirmPairingCode(input) {
      return callDurableState<PairingCodeConsumeResult>(
        namespace,
        TRUST_STORE_ROUTES.confirmPairingCode,
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
  const pairingCodes = new Map<
    string,
    {
      expiresAtMs: number;
      initiatorAgentDid: string;
      responderAgentDid: string;
    }
  >();

  function cleanup(nowMs: number): void {
    for (const [pairingCode, details] of pairingCodes.entries()) {
      if (details.expiresAtMs <= nowMs) {
        pairingCodes.delete(pairingCode);
      }
    }
  }

  function upsertPeer(leftAgentDid: string, rightAgentDid: string): void {
    const peers = agentPeers.get(leftAgentDid) ?? new Set<string>();
    peers.add(rightAgentDid);
    agentPeers.set(leftAgentDid, peers);
  }

  function resolveConsumablePairingCode(
    input: PairingCodeConsumeInput,
  ): PairingCodeConsumeResult {
    const nowMs = input.nowMs ?? Date.now();
    cleanup(nowMs);

    const pairing = pairingCodes.get(input.pairingCode);
    if (!pairing) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_CODE_NOT_FOUND",
        message: "Pairing code not found",
        status: 404,
      });
    }

    if (pairing.expiresAtMs <= nowMs) {
      pairingCodes.delete(input.pairingCode);
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_CODE_EXPIRED",
        message: "Pairing code has expired",
        status: 410,
      });
    }

    if (pairing.responderAgentDid !== input.responderAgentDid) {
      throw new ProxyTrustStoreError({
        code: "PROXY_PAIR_CODE_AGENT_MISMATCH",
        message: "Pairing code does not match caller agent DID",
        status: 403,
      });
    }

    return {
      initiatorAgentDid: pairing.initiatorAgentDid,
      responderAgentDid: pairing.responderAgentDid,
    };
  }

  return {
    async createPairingCode(input) {
      const nowMs = input.nowMs ?? Date.now();
      cleanup(nowMs);

      const pairingCode = generateUlid(nowMs);
      const expiresAtMs = nowMs + input.ttlSeconds * 1000;

      pairingCodes.set(pairingCode, {
        initiatorAgentDid: input.initiatorAgentDid,
        responderAgentDid: input.responderAgentDid,
        expiresAtMs,
      });

      return {
        pairingCode,
        expiresAtMs,
        initiatorAgentDid: input.initiatorAgentDid,
        responderAgentDid: input.responderAgentDid,
      };
    },
    async consumePairingCode(input) {
      const consumedPair = resolveConsumablePairingCode(input);
      pairingCodes.delete(input.pairingCode);
      return consumedPair;
    },
    async confirmPairingCode(input) {
      const consumedPair = resolveConsumablePairingCode(input);
      pairKeys.add(
        toPairKey(
          consumedPair.initiatorAgentDid,
          consumedPair.responderAgentDid,
        ),
      );
      upsertPeer(
        consumedPair.initiatorAgentDid,
        consumedPair.responderAgentDid,
      );
      upsertPeer(
        consumedPair.responderAgentDid,
        consumedPair.initiatorAgentDid,
      );
      pairingCodes.delete(input.pairingCode);
      return consumedPair;
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
