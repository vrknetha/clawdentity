import {
  normalizePairingTicketText,
  PairingTicketParseError,
  parsePairingTicket,
} from "../pairing-ticket.js";
import type { PeerProfile } from "../proxy-trust-store.js";
import type { AgentPeersIndex } from "./types.js";

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parsePeerProfile(value: unknown): PeerProfile | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const entry = value as {
    agentName?: unknown;
    humanName?: unknown;
    proxyOrigin?: unknown;
  };

  if (
    !isNonEmptyString(entry.agentName) ||
    !isNonEmptyString(entry.humanName)
  ) {
    return undefined;
  }

  const profile: PeerProfile = {
    agentName: entry.agentName.trim(),
    humanName: entry.humanName.trim(),
  };

  if (entry.proxyOrigin !== undefined) {
    if (!isNonEmptyString(entry.proxyOrigin)) {
      return undefined;
    }

    let parsedProxyOrigin: URL;
    try {
      parsedProxyOrigin = new URL(entry.proxyOrigin.trim());
    } catch {
      return undefined;
    }

    if (
      parsedProxyOrigin.protocol !== "https:" &&
      parsedProxyOrigin.protocol !== "http:"
    ) {
      return undefined;
    }

    profile.proxyOrigin = parsedProxyOrigin.origin;
  }

  return profile;
}

export function addPeer(
  index: AgentPeersIndex,
  leftAgentDid: string,
  rightAgentDid: string,
): void {
  const peers = new Set(index[leftAgentDid] ?? []);
  peers.add(rightAgentDid);
  index[leftAgentDid] = [...peers].sort();
}

export function toErrorResponse(input: {
  code: string;
  message: string;
  status: number;
}): Response {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
      },
    },
    { status: input.status },
  );
}

export async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

type ParsedPairingTicket = ReturnType<typeof parsePairingTicket>;

export type PairingTicketParseResult =
  | {
      ok: true;
      ticket: string;
      parsedTicket: ParsedPairingTicket;
    }
  | {
      ok: false;
      response: Response;
    };

export function parseNormalizedPairingTicket(
  rawTicket: string,
): PairingTicketParseResult {
  const ticket = normalizePairingTicketText(rawTicket);
  try {
    return {
      ok: true,
      ticket,
      parsedTicket: parsePairingTicket(ticket),
    };
  } catch (error) {
    if (error instanceof PairingTicketParseError) {
      return {
        ok: false,
        response: toErrorResponse({
          code: error.code,
          message: error.message,
          status: 400,
        }),
      };
    }

    throw error;
  }
}
