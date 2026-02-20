import { nowUtcMs } from "@clawdentity/sdk";
import {
  normalizeExpiryToWholeSecond,
  toPairKey,
} from "../proxy-trust-keys.js";
import type {
  PairingTicketConfirmInput,
  PairingTicketInput,
  PairingTicketStatusInput,
} from "../proxy-trust-store.js";
import type { ProxyTrustStateStorage } from "./storage.js";
import {
  addPeer,
  isNonEmptyString,
  parseBody,
  parseNormalizedPairingTicket,
  parsePeerProfile,
  toErrorResponse,
} from "./utils.js";

export class ProxyTrustStateHandlers {
  private readonly storage: ProxyTrustStateStorage;

  constructor(storage: ProxyTrustStateStorage) {
    this.storage = storage;
  }

  async handleCreatePairingTicket(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingTicketInput>
      | undefined;
    const initiatorProfile = parsePeerProfile(body?.initiatorProfile);
    if (
      !body ||
      !isNonEmptyString(body.initiatorAgentDid) ||
      !initiatorProfile ||
      !isNonEmptyString(body.issuerProxyUrl) ||
      !isNonEmptyString(body.ticket) ||
      typeof body.expiresAtMs !== "number" ||
      !Number.isInteger(body.expiresAtMs) ||
      body.expiresAtMs <= 0
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_START_INVALID_BODY",
        message: "Pairing ticket create input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : nowUtcMs();
    const normalizedExpiresAtMs = normalizeExpiryToWholeSecond(
      body.expiresAtMs,
    );
    const parsedTicketResult = parseNormalizedPairingTicket(body.ticket);
    if (!parsedTicketResult.ok) {
      return parsedTicketResult.response;
    }

    const { parsedTicket, ticket } = parsedTicketResult;
    if (parsedTicket.iss !== body.issuerProxyUrl) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_INVALID_ISSUER",
        message: "Pairing ticket issuer URL is invalid",
        status: 400,
      });
    }

    if (parsedTicket.exp * 1000 !== normalizedExpiresAtMs) {
      return toErrorResponse({
        code: "PROXY_PAIR_START_INVALID_BODY",
        message: "Pairing ticket expiry is invalid",
        status: 400,
      });
    }

    if (normalizedExpiresAtMs <= nowMs) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_EXPIRED",
        message: "Pairing ticket has expired",
        status: 410,
      });
    }

    const expirableState = await this.storage.loadExpirableState();
    expirableState.pairingTickets[parsedTicket.kid] = {
      ticket,
      initiatorAgentDid: body.initiatorAgentDid,
      initiatorProfile,
      issuerProxyUrl: parsedTicket.iss,
      expiresAtMs: normalizedExpiresAtMs,
    };
    delete expirableState.confirmedPairingTickets[parsedTicket.kid];

    await this.storage.saveExpirableStateAndSchedule(expirableState, {
      pairingTickets: true,
      confirmedPairingTickets: true,
    });

    return Response.json({
      ticket,
      expiresAtMs: normalizedExpiresAtMs,
      initiatorAgentDid: body.initiatorAgentDid,
      initiatorProfile,
      issuerProxyUrl: parsedTicket.iss,
    });
  }

  async handleConfirmPairingTicket(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingTicketConfirmInput>
      | undefined;
    const responderProfile = parsePeerProfile(body?.responderProfile);
    if (
      !body ||
      !isNonEmptyString(body.ticket) ||
      !isNonEmptyString(body.responderAgentDid) ||
      !responderProfile
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_CONFIRM_INVALID_BODY",
        message: "Pairing ticket confirm input is invalid",
        status: 400,
      });
    }

    const parsedTicketResult = parseNormalizedPairingTicket(body.ticket);
    if (!parsedTicketResult.ok) {
      return parsedTicketResult.response;
    }

    const { parsedTicket, ticket } = parsedTicketResult;
    const nowMs = typeof body.nowMs === "number" ? body.nowMs : nowUtcMs();
    const expirableState = await this.storage.loadExpirableState();
    const stored = expirableState.pairingTickets[parsedTicket.kid];

    if (!stored || stored.ticket !== ticket) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
      delete expirableState.pairingTickets[parsedTicket.kid];
      delete expirableState.confirmedPairingTickets[parsedTicket.kid];
      await this.storage.saveExpirableStateAndSchedule(expirableState, {
        pairingTickets: true,
        confirmedPairingTickets: true,
      });
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_EXPIRED",
        message: "Pairing ticket has expired",
        status: 410,
      });
    }

    if (stored.issuerProxyUrl !== parsedTicket.iss) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_INVALID_ISSUER",
        message: "Pairing ticket issuer URL is invalid",
        status: 400,
      });
    }

    const pairs = await this.storage.loadPairs();
    pairs.add(toPairKey(stored.initiatorAgentDid, body.responderAgentDid));

    const agentPeers = await this.storage.loadAgentPeers();
    addPeer(agentPeers, stored.initiatorAgentDid, body.responderAgentDid);
    addPeer(agentPeers, body.responderAgentDid, stored.initiatorAgentDid);

    await this.storage.savePairs(pairs);
    await this.storage.saveAgentPeers(agentPeers);

    delete expirableState.pairingTickets[parsedTicket.kid];
    expirableState.confirmedPairingTickets[parsedTicket.kid] = {
      ticket,
      expiresAtMs: stored.expiresAtMs,
      initiatorAgentDid: stored.initiatorAgentDid,
      initiatorProfile: stored.initiatorProfile,
      responderAgentDid: body.responderAgentDid,
      responderProfile,
      issuerProxyUrl: stored.issuerProxyUrl,
      confirmedAtMs: normalizeExpiryToWholeSecond(nowMs),
    };
    await this.storage.saveExpirableStateAndSchedule(expirableState, {
      pairingTickets: true,
      confirmedPairingTickets: true,
    });

    return Response.json({
      initiatorAgentDid: stored.initiatorAgentDid,
      initiatorProfile: stored.initiatorProfile,
      responderAgentDid: body.responderAgentDid,
      responderProfile,
      issuerProxyUrl: stored.issuerProxyUrl,
    });
  }

  async handleGetPairingTicketStatus(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingTicketStatusInput>
      | undefined;
    if (!body || !isNonEmptyString(body.ticket)) {
      return toErrorResponse({
        code: "PROXY_PAIR_STATUS_INVALID_BODY",
        message: "Pairing ticket status input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : nowUtcMs();
    const parsedTicketResult = parseNormalizedPairingTicket(body.ticket);
    if (!parsedTicketResult.ok) {
      return parsedTicketResult.response;
    }

    const { parsedTicket, ticket } = parsedTicketResult;
    const expirableState = await this.storage.loadExpirableState();

    const pending = expirableState.pairingTickets[parsedTicket.kid];
    if (pending && pending.ticket === ticket) {
      if (pending.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
        delete expirableState.pairingTickets[parsedTicket.kid];
        await this.storage.saveExpirableStateAndSchedule(expirableState, {
          pairingTickets: true,
        });
        return toErrorResponse({
          code: "PROXY_PAIR_TICKET_EXPIRED",
          message: "Pairing ticket has expired",
          status: 410,
        });
      }

      return Response.json({
        status: "pending",
        ticket: pending.ticket,
        initiatorAgentDid: pending.initiatorAgentDid,
        initiatorProfile: pending.initiatorProfile,
        issuerProxyUrl: pending.issuerProxyUrl,
        expiresAtMs: pending.expiresAtMs,
      });
    }

    const confirmed = expirableState.confirmedPairingTickets[parsedTicket.kid];
    if (confirmed && confirmed.ticket === ticket) {
      if (confirmed.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
        delete expirableState.confirmedPairingTickets[parsedTicket.kid];
        await this.storage.saveExpirableStateAndSchedule(expirableState, {
          confirmedPairingTickets: true,
        });
        return toErrorResponse({
          code: "PROXY_PAIR_TICKET_EXPIRED",
          message: "Pairing ticket has expired",
          status: 410,
        });
      }

      return Response.json({
        status: "confirmed",
        ticket: confirmed.ticket,
        initiatorAgentDid: confirmed.initiatorAgentDid,
        initiatorProfile: confirmed.initiatorProfile,
        responderAgentDid: confirmed.responderAgentDid,
        responderProfile: confirmed.responderProfile,
        issuerProxyUrl: confirmed.issuerProxyUrl,
        expiresAtMs: confirmed.expiresAtMs,
        confirmedAtMs: confirmed.confirmedAtMs,
      });
    }

    if (parsedTicket.exp * 1000 <= nowMs) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_EXPIRED",
        message: "Pairing ticket has expired",
        status: 410,
      });
    }

    return toErrorResponse({
      code: "PROXY_PAIR_TICKET_NOT_FOUND",
      message: "Pairing ticket not found",
      status: 404,
    });
  }

  async handleUpsertPair(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | { initiatorAgentDid?: unknown; responderAgentDid?: unknown }
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.initiatorAgentDid) ||
      !isNonEmptyString(body.responderAgentDid)
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_UPSERT_INVALID_BODY",
        message: "Pair upsert input is invalid",
        status: 400,
      });
    }

    const pairs = await this.storage.loadPairs();
    pairs.add(toPairKey(body.initiatorAgentDid, body.responderAgentDid));
    await this.storage.savePairs(pairs);

    const agentPeers = await this.storage.loadAgentPeers();
    addPeer(agentPeers, body.initiatorAgentDid, body.responderAgentDid);
    addPeer(agentPeers, body.responderAgentDid, body.initiatorAgentDid);
    await this.storage.saveAgentPeers(agentPeers);

    return Response.json({ ok: true });
  }

  async handleIsPairAllowed(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | { initiatorAgentDid?: unknown; responderAgentDid?: unknown }
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.initiatorAgentDid) ||
      !isNonEmptyString(body.responderAgentDid)
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_CHECK_INVALID_BODY",
        message: "Pair check input is invalid",
        status: 400,
      });
    }

    if (body.initiatorAgentDid === body.responderAgentDid) {
      return Response.json({ allowed: true });
    }

    const pairs = await this.storage.loadPairs();
    return Response.json({
      allowed: pairs.has(
        toPairKey(body.initiatorAgentDid, body.responderAgentDid),
      ),
    });
  }

  async handleIsAgentKnown(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | { agentDid?: unknown }
      | undefined;
    if (!body || !isNonEmptyString(body.agentDid)) {
      return toErrorResponse({
        code: "PROXY_AGENT_KNOWN_INVALID_BODY",
        message: "Agent known check input is invalid",
        status: 400,
      });
    }

    const agentPeers = await this.storage.loadAgentPeers();
    if ((agentPeers[body.agentDid]?.length ?? 0) > 0) {
      return Response.json({ known: true });
    }

    return Response.json({ known: false });
  }
}
