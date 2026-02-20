import { nowUtcMs } from "@clawdentity/sdk";
import {
  normalizePairingTicketText,
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";
import { normalizeExpiryToWholeSecond, toPairKey } from "./proxy-trust-keys.js";
import {
  type PairingTicketConfirmInput,
  type PairingTicketInput,
  type PairingTicketStatusInput,
  type PeerProfile,
  TRUST_STORE_ROUTES,
} from "./proxy-trust-store.js";

type StoredPairingTicket = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  issuerProxyUrl: string;
};

type StoredConfirmedPairingTicket = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  issuerProxyUrl: string;
  confirmedAtMs: number;
};

type PairingTicketMap = Record<string, StoredPairingTicket>;
type ConfirmedPairingTicketMap = Record<string, StoredConfirmedPairingTicket>;
type AgentPeersIndex = Record<string, string[]>;
type ExpirableTrustState = {
  pairingTickets: PairingTicketMap;
  confirmedPairingTickets: ConfirmedPairingTicketMap;
};

const PAIRS_STORAGE_KEY = "trust:pairs";
const AGENT_PEERS_STORAGE_KEY = "trust:agent-peers";
const PAIRING_TICKETS_STORAGE_KEY = "trust:pairing-tickets";
const CONFIRMED_PAIRING_TICKETS_STORAGE_KEY = "trust:pairing-tickets-confirmed";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePeerProfile(value: unknown): PeerProfile | undefined {
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

function addPeer(
  index: AgentPeersIndex,
  leftAgentDid: string,
  rightAgentDid: string,
): void {
  const peers = new Set(index[leftAgentDid] ?? []);
  peers.add(rightAgentDid);
  index[leftAgentDid] = [...peers].sort();
}

function toErrorResponse(input: {
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

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export class ProxyTrustState {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === TRUST_STORE_ROUTES.createPairingTicket) {
      return this.handleCreatePairingTicket(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.confirmPairingTicket) {
      return this.handleConfirmPairingTicket(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.getPairingTicketStatus) {
      return this.handleGetPairingTicketStatus(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.upsertPair) {
      return this.handleUpsertPair(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.isPairAllowed) {
      return this.handleIsPairAllowed(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.isAgentKnown) {
      return this.handleIsAgentKnown(request);
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const nowMs = nowUtcMs();
    const expirableState = await this.loadExpirableState();
    const mutated = this.removeExpiredEntries(expirableState, nowMs);
    if (mutated) {
      await this.saveExpirableState(expirableState, {
        pairingTickets: true,
        confirmedPairingTickets: true,
      });
    }
    await this.scheduleNextCodeCleanup(
      expirableState.pairingTickets,
      expirableState.confirmedPairingTickets,
    );
  }

  private async handleCreatePairingTicket(request: Request): Promise<Response> {
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
    const ticket = normalizePairingTicketText(body.ticket);
    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(ticket);
    } catch (error) {
      if (error instanceof PairingTicketParseError) {
        return toErrorResponse({
          code: error.code,
          message: error.message,
          status: 400,
        });
      }

      throw error;
    }

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

    const expirableState = await this.loadExpirableState();
    expirableState.pairingTickets[parsedTicket.kid] = {
      ticket,
      initiatorAgentDid: body.initiatorAgentDid,
      initiatorProfile,
      issuerProxyUrl: parsedTicket.iss,
      expiresAtMs: normalizedExpiresAtMs,
    };
    delete expirableState.confirmedPairingTickets[parsedTicket.kid];

    await this.saveExpirableStateAndSchedule(expirableState, {
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

  private async handleConfirmPairingTicket(
    request: Request,
  ): Promise<Response> {
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

    const ticket = normalizePairingTicketText(body.ticket);
    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(ticket);
    } catch (error) {
      if (error instanceof PairingTicketParseError) {
        return toErrorResponse({
          code: error.code,
          message: error.message,
          status: 400,
        });
      }

      throw error;
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : nowUtcMs();
    const expirableState = await this.loadExpirableState();
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
      await this.saveExpirableStateAndSchedule(expirableState, {
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

    const pairs = await this.loadPairs();
    pairs.add(toPairKey(stored.initiatorAgentDid, body.responderAgentDid));

    const agentPeers = await this.loadAgentPeers();
    addPeer(agentPeers, stored.initiatorAgentDid, body.responderAgentDid);
    addPeer(agentPeers, body.responderAgentDid, stored.initiatorAgentDid);

    await this.savePairs(pairs);
    await this.saveAgentPeers(agentPeers);

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
    await this.saveExpirableStateAndSchedule(expirableState, {
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

  private async handleGetPairingTicketStatus(
    request: Request,
  ): Promise<Response> {
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
    const ticket = normalizePairingTicketText(body.ticket);
    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(ticket);
    } catch (error) {
      if (error instanceof PairingTicketParseError) {
        return toErrorResponse({
          code: error.code,
          message: error.message,
          status: 400,
        });
      }

      throw error;
    }

    const expirableState = await this.loadExpirableState();

    const pending = expirableState.pairingTickets[parsedTicket.kid];
    if (pending && pending.ticket === ticket) {
      if (pending.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
        delete expirableState.pairingTickets[parsedTicket.kid];
        await this.saveExpirableStateAndSchedule(expirableState, {
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
        await this.saveExpirableStateAndSchedule(expirableState, {
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

  private async handleUpsertPair(request: Request): Promise<Response> {
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

    const pairs = await this.loadPairs();
    pairs.add(toPairKey(body.initiatorAgentDid, body.responderAgentDid));
    await this.savePairs(pairs);

    const agentPeers = await this.loadAgentPeers();
    addPeer(agentPeers, body.initiatorAgentDid, body.responderAgentDid);
    addPeer(agentPeers, body.responderAgentDid, body.initiatorAgentDid);
    await this.saveAgentPeers(agentPeers);

    return Response.json({ ok: true });
  }

  private async handleIsPairAllowed(request: Request): Promise<Response> {
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

    const pairs = await this.loadPairs();
    return Response.json({
      allowed: pairs.has(
        toPairKey(body.initiatorAgentDid, body.responderAgentDid),
      ),
    });
  }

  private async handleIsAgentKnown(request: Request): Promise<Response> {
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

    const agentPeers = await this.loadAgentPeers();
    if ((agentPeers[body.agentDid]?.length ?? 0) > 0) {
      return Response.json({ known: true });
    }

    return Response.json({ known: false });
  }

  private async loadExpirableState(): Promise<ExpirableTrustState> {
    const [pairingTickets, confirmedPairingTickets] = await Promise.all([
      this.loadPairingTickets(),
      this.loadConfirmedPairingTickets(),
    ]);

    return { pairingTickets, confirmedPairingTickets };
  }

  private removeExpiredEntries(
    state: ExpirableTrustState,
    nowMs: number,
  ): boolean {
    let mutated = false;

    for (const [ticketKid, details] of Object.entries(state.pairingTickets)) {
      if (details.expiresAtMs <= nowMs) {
        delete state.pairingTickets[ticketKid];
        mutated = true;
      }
    }

    for (const [ticketKid, details] of Object.entries(
      state.confirmedPairingTickets,
    )) {
      if (details.expiresAtMs <= nowMs) {
        delete state.confirmedPairingTickets[ticketKid];
        mutated = true;
      }
    }

    return mutated;
  }

  private async saveExpirableState(
    state: ExpirableTrustState,
    options: {
      pairingTickets?: boolean;
      confirmedPairingTickets?: boolean;
    },
  ): Promise<void> {
    const saves: Promise<void>[] = [];
    if (options.pairingTickets) {
      saves.push(this.savePairingTickets(state.pairingTickets));
    }
    if (options.confirmedPairingTickets) {
      saves.push(
        this.saveConfirmedPairingTickets(state.confirmedPairingTickets),
      );
    }
    if (saves.length > 0) {
      await Promise.all(saves);
    }
  }

  private async saveExpirableStateAndSchedule(
    state: ExpirableTrustState,
    options: {
      pairingTickets?: boolean;
      confirmedPairingTickets?: boolean;
    },
  ): Promise<void> {
    await this.saveExpirableState(state, options);
    await this.scheduleNextCodeCleanup(
      state.pairingTickets,
      state.confirmedPairingTickets,
    );
  }

  private async loadPairs(): Promise<Set<string>> {
    const raw = await this.state.storage.get<string[]>(PAIRS_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return new Set<string>();
    }

    const normalized = raw.filter((value) => typeof value === "string");
    return new Set(normalized);
  }

  private async savePairs(pairs: Set<string>): Promise<void> {
    await this.state.storage.put(PAIRS_STORAGE_KEY, [...pairs].sort());
  }

  private async loadAgentPeers(): Promise<AgentPeersIndex> {
    const raw = await this.state.storage.get<AgentPeersIndex>(
      AGENT_PEERS_STORAGE_KEY,
    );
    if (typeof raw !== "object" || raw === null) {
      return {};
    }

    const normalized: AgentPeersIndex = {};
    for (const [agentDid, peers] of Object.entries(raw)) {
      if (!Array.isArray(peers)) {
        continue;
      }

      normalized[agentDid] = peers.filter((peer): peer is string =>
        isNonEmptyString(peer),
      );
    }

    return normalized;
  }

  private async saveAgentPeers(agentPeers: AgentPeersIndex): Promise<void> {
    await this.state.storage.put(AGENT_PEERS_STORAGE_KEY, agentPeers);
  }

  private async loadPairingTickets(): Promise<PairingTicketMap> {
    const raw = await this.state.storage.get<PairingTicketMap>(
      PAIRING_TICKETS_STORAGE_KEY,
    );

    if (typeof raw !== "object" || raw === null) {
      return {};
    }

    const normalized: PairingTicketMap = {};
    for (const [entryKey, value] of Object.entries(raw)) {
      if (typeof value !== "object" || value === null) {
        continue;
      }

      const entry = value as {
        ticket?: unknown;
        expiresAtMs?: unknown;
        initiatorAgentDid?: unknown;
        initiatorProfile?: unknown;
        issuerProxyUrl?: unknown;
      };
      const initiatorProfile = parsePeerProfile(entry.initiatorProfile);
      if (
        !isNonEmptyString(entry.initiatorAgentDid) ||
        !initiatorProfile ||
        !isNonEmptyString(entry.issuerProxyUrl) ||
        typeof entry.expiresAtMs !== "number" ||
        !Number.isInteger(entry.expiresAtMs)
      ) {
        continue;
      }

      const ticketCandidate = isNonEmptyString(entry.ticket)
        ? entry.ticket
        : entryKey;
      let parsedTicket: ReturnType<typeof parsePairingTicket>;
      try {
        parsedTicket = parsePairingTicket(ticketCandidate);
      } catch {
        continue;
      }

      normalized[parsedTicket.kid] = {
        ticket: ticketCandidate,
        expiresAtMs: entry.expiresAtMs,
        initiatorAgentDid: entry.initiatorAgentDid,
        initiatorProfile,
        issuerProxyUrl: parsedTicket.iss,
      };
    }

    return normalized;
  }

  private async savePairingTickets(
    pairingTickets: PairingTicketMap,
  ): Promise<void> {
    await this.state.storage.put(PAIRING_TICKETS_STORAGE_KEY, pairingTickets);
  }

  private async loadConfirmedPairingTickets(): Promise<ConfirmedPairingTicketMap> {
    const raw = await this.state.storage.get<ConfirmedPairingTicketMap>(
      CONFIRMED_PAIRING_TICKETS_STORAGE_KEY,
    );

    if (typeof raw !== "object" || raw === null) {
      return {};
    }

    const normalized: ConfirmedPairingTicketMap = {};
    for (const [entryKey, value] of Object.entries(raw)) {
      if (typeof value !== "object" || value === null) {
        continue;
      }

      const entry = value as {
        ticket?: unknown;
        expiresAtMs?: unknown;
        initiatorAgentDid?: unknown;
        initiatorProfile?: unknown;
        responderAgentDid?: unknown;
        responderProfile?: unknown;
        issuerProxyUrl?: unknown;
        confirmedAtMs?: unknown;
      };
      const initiatorProfile = parsePeerProfile(entry.initiatorProfile);
      const responderProfile = parsePeerProfile(entry.responderProfile);

      if (
        !isNonEmptyString(entry.initiatorAgentDid) ||
        !initiatorProfile ||
        !isNonEmptyString(entry.responderAgentDid) ||
        !responderProfile ||
        !isNonEmptyString(entry.issuerProxyUrl) ||
        typeof entry.expiresAtMs !== "number" ||
        !Number.isInteger(entry.expiresAtMs) ||
        typeof entry.confirmedAtMs !== "number" ||
        !Number.isInteger(entry.confirmedAtMs)
      ) {
        continue;
      }

      const ticketCandidate = isNonEmptyString(entry.ticket)
        ? entry.ticket
        : entryKey;
      let parsedTicket: ReturnType<typeof parsePairingTicket>;
      try {
        parsedTicket = parsePairingTicket(ticketCandidate);
      } catch {
        continue;
      }

      normalized[parsedTicket.kid] = {
        ticket: ticketCandidate,
        expiresAtMs: entry.expiresAtMs,
        initiatorAgentDid: entry.initiatorAgentDid,
        initiatorProfile,
        responderAgentDid: entry.responderAgentDid,
        responderProfile,
        issuerProxyUrl: parsedTicket.iss,
        confirmedAtMs: entry.confirmedAtMs,
      };
    }

    return normalized;
  }

  private async saveConfirmedPairingTickets(
    pairingTickets: ConfirmedPairingTicketMap,
  ): Promise<void> {
    await this.state.storage.put(
      CONFIRMED_PAIRING_TICKETS_STORAGE_KEY,
      pairingTickets,
    );
  }

  private async scheduleNextCodeCleanup(
    pairingTickets: PairingTicketMap,
    confirmedPairingTickets: ConfirmedPairingTicketMap,
  ): Promise<void> {
    const expiryValues = [
      ...Object.values(pairingTickets),
      ...Object.values(confirmedPairingTickets),
    ].map((details) => details.expiresAtMs);

    if (expiryValues.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }

    const earliestExpiry = Math.min(...expiryValues);
    await this.state.storage.setAlarm(earliestExpiry);
  }
}
