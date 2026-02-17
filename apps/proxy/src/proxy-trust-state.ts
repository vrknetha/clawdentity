import { generateUlid } from "@clawdentity/protocol";
import {
  type PairingCodeConsumeInput,
  type PairingCodeInput,
  TRUST_STORE_ROUTES,
} from "./proxy-trust-store.js";

type StoredPairingCode = {
  expiresAtMs: number;
  initiatorAgentDid: string;
  responderAgentDid: string;
};

type PairingCodeMap = Record<string, StoredPairingCode>;
type AgentPeersIndex = Record<string, string[]>;

const PAIRS_STORAGE_KEY = "trust:pairs";
const AGENT_PEERS_STORAGE_KEY = "trust:agent-peers";
const PAIRING_CODES_STORAGE_KEY = "trust:pairing-codes";

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

    if (url.pathname === TRUST_STORE_ROUTES.createPairingCode) {
      return this.handleCreatePairingCode(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.consumePairingCode) {
      return this.handleConsumePairingCode(request);
    }

    if (url.pathname === TRUST_STORE_ROUTES.confirmPairingCode) {
      return this.handleConfirmPairingCode(request);
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
    const pairingCodes = await this.loadPairingCodes();

    let mutated = false;
    for (const [pairingCode, details] of Object.entries(pairingCodes)) {
      if (details.expiresAtMs <= nowMs) {
        delete pairingCodes[pairingCode];
        mutated = true;
      }
    }

    if (mutated) {
      await this.savePairingCodes(pairingCodes);
    }

    await this.scheduleNextCodeCleanup(pairingCodes);
  }

  private async handleCreatePairingCode(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingCodeInput>
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.initiatorAgentDid) ||
      !isNonEmptyString(body.responderAgentDid) ||
      typeof body.ttlSeconds !== "number" ||
      !Number.isInteger(body.ttlSeconds) ||
      body.ttlSeconds <= 0
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_START_INVALID_BODY",
        message: "Pairing code create input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    const pairingCode = generateUlid(nowMs);
    const expiresAtMs = nowMs + body.ttlSeconds * 1000;

    const pairingCodes = await this.loadPairingCodes();
    pairingCodes[pairingCode] = {
      initiatorAgentDid: body.initiatorAgentDid,
      responderAgentDid: body.responderAgentDid,
      expiresAtMs,
    };

    await this.savePairingCodes(pairingCodes);
    await this.scheduleNextCodeCleanup(pairingCodes);

    return Response.json({
      pairingCode,
      expiresAtMs,
      initiatorAgentDid: body.initiatorAgentDid,
      responderAgentDid: body.responderAgentDid,
    });
  }

  private async handleConsumePairingCode(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingCodeConsumeInput>
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.pairingCode) ||
      !isNonEmptyString(body.responderAgentDid)
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_CONFIRM_INVALID_BODY",
        message: "Pairing code consume input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    const pairingCodes = await this.loadPairingCodes();
    const stored = pairingCodes[body.pairingCode];

    if (!stored) {
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_NOT_FOUND",
        message: "Pairing code not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs) {
      delete pairingCodes[body.pairingCode];
      await this.savePairingCodes(pairingCodes);
      await this.scheduleNextCodeCleanup(pairingCodes);
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_EXPIRED",
        message: "Pairing code has expired",
        status: 410,
      });
    }

    if (stored.responderAgentDid !== body.responderAgentDid) {
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_AGENT_MISMATCH",
        message: "Pairing code does not match caller agent DID",
        status: 403,
      });
    }

    delete pairingCodes[body.pairingCode];
    await this.savePairingCodes(pairingCodes);
    await this.scheduleNextCodeCleanup(pairingCodes);

    return Response.json({
      initiatorAgentDid: stored.initiatorAgentDid,
      responderAgentDid: stored.responderAgentDid,
    });
  }

  private async handleConfirmPairingCode(request: Request): Promise<Response> {
    const body = (await parseBody(request)) as
      | Partial<PairingCodeConsumeInput>
      | undefined;
    if (
      !body ||
      !isNonEmptyString(body.pairingCode) ||
      !isNonEmptyString(body.responderAgentDid)
    ) {
      return toErrorResponse({
        code: "PROXY_PAIR_CONFIRM_INVALID_BODY",
        message: "Pairing code consume input is invalid",
        status: 400,
      });
    }

    const nowMs = typeof body.nowMs === "number" ? body.nowMs : Date.now();
    const pairingCodes = await this.loadPairingCodes();
    const stored = pairingCodes[body.pairingCode];

    if (!stored) {
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_NOT_FOUND",
        message: "Pairing code not found",
        status: 404,
      });
    }

    if (stored.expiresAtMs <= nowMs) {
      delete pairingCodes[body.pairingCode];
      await this.savePairingCodes(pairingCodes);
      await this.scheduleNextCodeCleanup(pairingCodes);
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_EXPIRED",
        message: "Pairing code has expired",
        status: 410,
      });
    }

    if (stored.responderAgentDid !== body.responderAgentDid) {
      return toErrorResponse({
        code: "PROXY_PAIR_CODE_AGENT_MISMATCH",
        message: "Pairing code does not match caller agent DID",
        status: 403,
      });
    }

    const pairs = await this.loadPairs();
    pairs.add(toPairKey(stored.initiatorAgentDid, stored.responderAgentDid));

    const agentPeers = await this.loadAgentPeers();
    addPeer(agentPeers, stored.initiatorAgentDid, stored.responderAgentDid);
    addPeer(agentPeers, stored.responderAgentDid, stored.initiatorAgentDid);

    await this.savePairs(pairs);
    await this.saveAgentPeers(agentPeers);

    delete pairingCodes[body.pairingCode];
    await this.savePairingCodes(pairingCodes);
    await this.scheduleNextCodeCleanup(pairingCodes);

    return Response.json({
      initiatorAgentDid: stored.initiatorAgentDid,
      responderAgentDid: stored.responderAgentDid,
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

  private async loadPairingCodes(): Promise<PairingCodeMap> {
    const raw = await this.state.storage.get<PairingCodeMap>(
      PAIRING_CODES_STORAGE_KEY,
    );

    if (typeof raw !== "object" || raw === null) {
      return {};
    }

    return raw;
  }

  private async savePairingCodes(pairingCodes: PairingCodeMap): Promise<void> {
    await this.state.storage.put(PAIRING_CODES_STORAGE_KEY, pairingCodes);
  }

  private async scheduleNextCodeCleanup(
    pairingCodes: PairingCodeMap,
  ): Promise<void> {
    const expiryValues = Object.values(pairingCodes).map(
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
