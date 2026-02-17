import {
  createPairingTicket,
  PairingTicketParseError,
  parsePairingTicket,
} from "./pairing-ticket.js";
import {
  type PairingTicketConfirmInput,
  type PairingTicketInput,
  TRUST_STORE_ROUTES,
} from "./proxy-trust-store.js";

type StoredPairingTicket = {
  expiresAtMs: number;
  initiatorAgentDid: string;
  issuerProxyUrl: string;
};

type PairingTicketMap = Record<string, StoredPairingTicket>;
type AgentPeersIndex = Record<string, string[]>;

const PAIRS_STORAGE_KEY = "trust:pairs";
const AGENT_PEERS_STORAGE_KEY = "trust:agent-peers";
const PAIRING_TICKETS_STORAGE_KEY = "trust:pairing-tickets";

function toPairKey(
  initiatorAgentDid: string,
  responderAgentDid: string,
): string {
  return [initiatorAgentDid, responderAgentDid].sort().join("|");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    const nowMs = Date.now();
    const pairingTickets = await this.loadPairingTickets();

    let mutated = false;
    for (const [ticket, details] of Object.entries(pairingTickets)) {
      if (details.expiresAtMs <= nowMs) {
        delete pairingTickets[ticket];
        mutated = true;
      }
    }

    if (mutated) {
      await this.savePairingTickets(pairingTickets);
    }

    await this.scheduleNextCodeCleanup(pairingTickets);
  }

  private async handleCreatePairingTicket(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingTicketInput>
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.initiatorAgentDid) ||
      !isNonEmptyString(body.issuerProxyUrl) ||
      typeof body.ttlSeconds !== "number" ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds <= 0
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_START_INVALID_BODY",
        message: "Pairing ticket create input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    const expiresAtMs = nowMs + body.ttlSeconds * 1000;

    let created: ReturnType<typeof createPairingTicket>;
    try {
      created = createPairingTicket({
        issuerProxyUrl: body.issuerProxyUrl,
        expiresAtMs,
        nowMs,
      });
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

    const pairingTickets = await this.loadPairingTickets();
    pairingTickets[created.ticket] = {
      initiatorAgentDid: body.initiatorAgentDid,
      issuerProxyUrl: created.payload.iss,
      expiresAtMs,
    };

    await this.savePairingTickets(pairingTickets);
    await this.scheduleNextCodeCleanup(pairingTickets);

    return Response.json({
      ticket: created.ticket,
      expiresAtMs,
      initiatorAgentDid: body.initiatorAgentDid,
      issuerProxyUrl: created.payload.iss,
    });
  }

  private async handleConfirmPairingTicket(
    request: Request,
  ): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingTicketConfirmInput>
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.ticket) ||
      !isNonEmptyString(body.responderAgentDid)
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_CONFIRM_INVALID_BODY",
        message: "Pairing ticket confirm input is invalid",
        status: 400,
      });
    }

    let parsedTicket: ReturnType<typeof parsePairingTicket>;
    try {
      parsedTicket = parsePairingTicket(body.ticket);
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

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    const pairingTickets = await this.loadPairingTickets();
    const stored = pairingTickets[body.ticket];

    if (!stored) {
      return toErrorResponse({
        code: "PROXY_PAIR_TICKET_NOT_FOUND",
        message: "Pairing ticket not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs || parsedTicket.exp * 1000 <= nowMs) {
      delete pairingTickets[body.ticket];
      await this.savePairingTickets(pairingTickets);
      await this.scheduleNextCodeCleanup(pairingTickets);
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

    delete pairingTickets[body.ticket];
    await this.savePairingTickets(pairingTickets);
    await this.scheduleNextCodeCleanup(pairingTickets);

    return Response.json({
      initiatorAgentDid: stored.initiatorAgentDid,
      responderAgentDid: body.responderAgentDid,
      issuerProxyUrl: stored.issuerProxyUrl,
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

    return raw;
  }

  private async savePairingTickets(
    pairingTickets: PairingTicketMap,
  ): Promise<void> {
    await this.state.storage.put(PAIRING_TICKETS_STORAGE_KEY, pairingTickets);
  }

  private async scheduleNextCodeCleanup(
    pairingTickets: PairingTicketMap,
  ): Promise<void> {
    const expiryValues = Object.values(pairingTickets).map(
      (details) => details.expiresAtMs,
    );

    if (expiryValues.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }

    const earliestExpiry = Math.min(...expiryValues);
    await this.state.storage.setAlarm(earliestExpiry);
  }
}
