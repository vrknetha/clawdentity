import type { PeerProfile } from "../proxy-trust-store.js";

export type StoredPairingTicket = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  issuerProxyUrl: string;
  publicKeyX: string;
  allowResponderAgentDid?: string;
};

export type StoredConfirmedPairingTicket = {
  ticket: string;
  expiresAtMs: number;
  initiatorAgentDid: string;
  initiatorProfile: PeerProfile;
  responderAgentDid: string;
  responderProfile: PeerProfile;
  issuerProxyUrl: string;
  confirmedAtMs: number;
};

export type PairingTicketMap = Record<string, StoredPairingTicket>;
export type ConfirmedPairingTicketMap = Record<
  string,
  StoredConfirmedPairingTicket
>;
export type AgentPeersIndex = Record<string, string[]>;
export type RevokedAgentMap = Record<
  string,
  {
    expiresAtMs: number;
  }
>;

export type ExpirableTrustState = {
  pairingTickets: PairingTicketMap;
  confirmedPairingTickets: ConfirmedPairingTicketMap;
};

export type ExpirableStateSaveOptions = {
  pairingTickets?: boolean;
  confirmedPairingTickets?: boolean;
};

export const PAIRS_STORAGE_KEY = "trust:pairs";
export const AGENT_PEERS_STORAGE_KEY = "trust:agent-peers";
export const REVOKED_AGENTS_STORAGE_KEY = "trust:revoked-agents";
export const PAIRING_TICKETS_STORAGE_KEY = "trust:pairing-tickets";
export const CONFIRMED_PAIRING_TICKETS_STORAGE_KEY =
  "trust:pairing-tickets-confirmed";
