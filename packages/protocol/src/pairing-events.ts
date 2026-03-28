import { parseAgentDid } from "./did.js";

export const PAIR_ACCEPTED_EVENT_TYPE = "pair.accepted";
export const PAIR_ACCEPTED_TRUSTED_DELIVERY_SOURCE =
  "proxy.events.queue.pair_accepted";

export type PairAcceptedResponderProfile = {
  agentName: string;
  humanName: string;
  proxyOrigin: string;
};

export type PairAcceptedEvent = {
  type: typeof PAIR_ACCEPTED_EVENT_TYPE;
  initiatorAgentDid: string;
  responderAgentDid: string;
  responderProfile: PairAcceptedResponderProfile;
  issuerProxyOrigin: string;
  eventTimestampUtc: string;
};

function parseNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Pair accepted event field '${field}' must be a non-empty string`,
    );
  }

  return value.trim();
}

function parseAgentDidString(value: unknown, field: string): string {
  const normalized = parseNonBlankString(value, field);
  parseAgentDid(normalized);
  return normalized;
}

function parseHttpOrigin(value: unknown, field: string): string {
  const normalized = parseNonBlankString(value, field);

  type ParsedUrl = {
    protocol: string;
    origin: string;
  };
  const urlCtor = (globalThis as { URL?: new (input: string) => ParsedUrl })
    .URL;
  if (typeof urlCtor !== "function") {
    throw new Error(
      `Pair accepted event field '${field}' must be a valid http(s) URL origin`,
    );
  }

  let parsed: ParsedUrl;
  try {
    parsed = new urlCtor(normalized);
  } catch {
    throw new Error(
      `Pair accepted event field '${field}' must be a valid http(s) URL origin`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Pair accepted event field '${field}' must be a valid http(s) URL origin`,
    );
  }

  return parsed.origin;
}

function parseTimestampUtc(value: unknown): string {
  const normalized = parseNonBlankString(value, "eventTimestampUtc");
  const isoTimestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!isoTimestampPattern.test(normalized)) {
    throw new Error(
      "Pair accepted event field 'eventTimestampUtc' must be a valid ISO timestamp",
    );
  }

  const epochMs = Date.parse(normalized);
  if (Number.isNaN(epochMs)) {
    throw new Error(
      "Pair accepted event field 'eventTimestampUtc' must be a valid ISO timestamp",
    );
  }

  return new Date(epochMs).toISOString();
}

function parseResponderProfile(value: unknown): PairAcceptedResponderProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "Pair accepted event field 'responderProfile' must be an object",
    );
  }

  const profile = value as {
    agentName?: unknown;
    humanName?: unknown;
    proxyOrigin?: unknown;
  };
  const normalized: PairAcceptedResponderProfile = {
    agentName: parseNonBlankString(
      profile.agentName,
      "responderProfile.agentName",
    ),
    humanName: parseNonBlankString(
      profile.humanName,
      "responderProfile.humanName",
    ),
    proxyOrigin: parseHttpOrigin(
      profile.proxyOrigin,
      "responderProfile.proxyOrigin",
    ),
  };

  return normalized;
}

export function parsePairAcceptedEvent(payload: unknown): PairAcceptedEvent {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Pair accepted event payload must be an object");
  }

  const event = payload as {
    type?: unknown;
    initiatorAgentDid?: unknown;
    responderAgentDid?: unknown;
    responderProfile?: unknown;
    issuerProxyOrigin?: unknown;
    eventTimestampUtc?: unknown;
  };

  if (event.type !== PAIR_ACCEPTED_EVENT_TYPE) {
    throw new Error("Unsupported pair accepted event type");
  }

  return {
    type: PAIR_ACCEPTED_EVENT_TYPE,
    initiatorAgentDid: parseAgentDidString(
      event.initiatorAgentDid,
      "initiatorAgentDid",
    ),
    responderAgentDid: parseAgentDidString(
      event.responderAgentDid,
      "responderAgentDid",
    ),
    responderProfile: parseResponderProfile(event.responderProfile),
    issuerProxyOrigin: parseHttpOrigin(
      event.issuerProxyOrigin,
      "issuerProxyOrigin",
    ),
    eventTimestampUtc: parseTimestampUtc(event.eventTimestampUtc),
  };
}

export type CreatePairAcceptedEventInput = {
  initiatorAgentDid: string;
  responderAgentDid: string;
  responderProfile: PairAcceptedResponderProfile;
  issuerProxyOrigin: string;
  eventTimestampUtc: string;
};

export function createPairAcceptedEvent(
  input: CreatePairAcceptedEventInput,
): PairAcceptedEvent {
  return parsePairAcceptedEvent({
    type: PAIR_ACCEPTED_EVENT_TYPE,
    ...input,
  });
}
