import { parsePairingTicket } from "../pairing-ticket.js";
import type {
  AgentPeersIndex,
  ConfirmedPairingTicketMap,
  ExpirableStateSaveOptions,
  ExpirableTrustState,
  PairingTicketMap,
} from "./types.js";
import {
  AGENT_PEERS_STORAGE_KEY,
  CONFIRMED_PAIRING_TICKETS_STORAGE_KEY,
  PAIRING_TICKETS_STORAGE_KEY,
  PAIRS_STORAGE_KEY,
} from "./types.js";
import { isNonEmptyString, parsePeerProfile } from "./utils.js";

function normalizeOptionalCallbackUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isNonEmptyString(value)) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return undefined;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return undefined;
  }

  return parsedUrl.toString();
}

export class ProxyTrustStateStorage {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async runAlarmCleanup(nowMs: number): Promise<void> {
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

  async loadExpirableState(): Promise<ExpirableTrustState> {
    const [pairingTickets, confirmedPairingTickets] = await Promise.all([
      this.loadPairingTickets(),
      this.loadConfirmedPairingTickets(),
    ]);

    return { pairingTickets, confirmedPairingTickets };
  }

  async saveExpirableStateAndSchedule(
    state: ExpirableTrustState,
    options: ExpirableStateSaveOptions,
  ): Promise<void> {
    await this.saveExpirableState(state, options);
    await this.scheduleNextCodeCleanup(
      state.pairingTickets,
      state.confirmedPairingTickets,
    );
  }

  async loadPairs(): Promise<Set<string>> {
    const raw = await this.state.storage.get<string[]>(PAIRS_STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return new Set<string>();
    }

    const normalized = raw.filter((value) => typeof value === "string");
    return new Set(normalized);
  }

  async savePairs(pairs: Set<string>): Promise<void> {
    await this.state.storage.put(PAIRS_STORAGE_KEY, [...pairs].sort());
  }

  async loadAgentPeers(): Promise<AgentPeersIndex> {
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

  async saveAgentPeers(agentPeers: AgentPeersIndex): Promise<void> {
    await this.state.storage.put(AGENT_PEERS_STORAGE_KEY, agentPeers);
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
    options: ExpirableStateSaveOptions,
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
        publicKeyX?: unknown;
        allowResponderAgentDid?: unknown;
        callbackUrl?: unknown;
      };
      const initiatorProfile = parsePeerProfile(entry.initiatorProfile);
      const callbackUrl = normalizeOptionalCallbackUrl(entry.callbackUrl);
      if (
        !isNonEmptyString(entry.initiatorAgentDid) ||
        !initiatorProfile ||
        !isNonEmptyString(entry.issuerProxyUrl) ||
        typeof entry.expiresAtMs !== "number" ||
        !Number.isInteger(entry.expiresAtMs)
      ) {
        continue;
      }
      if (entry.callbackUrl !== undefined && callbackUrl === undefined) {
        continue;
      }
      if (
        entry.publicKeyX !== undefined &&
        !isNonEmptyString(entry.publicKeyX)
      ) {
        continue;
      }
      if (
        entry.allowResponderAgentDid !== undefined &&
        !isNonEmptyString(entry.allowResponderAgentDid)
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
        publicKeyX: isNonEmptyString(entry.publicKeyX)
          ? entry.publicKeyX
          : undefined,
        allowResponderAgentDid: isNonEmptyString(entry.allowResponderAgentDid)
          ? entry.allowResponderAgentDid
          : undefined,
        callbackUrl,
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
        callbackUrl?: unknown;
      };
      const initiatorProfile = parsePeerProfile(entry.initiatorProfile);
      const responderProfile = parsePeerProfile(entry.responderProfile);
      const callbackUrl = normalizeOptionalCallbackUrl(entry.callbackUrl);

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
      if (entry.callbackUrl !== undefined && callbackUrl === undefined) {
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
        callbackUrl,
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
