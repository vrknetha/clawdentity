import {
  decodeBase64url,
  encodeBase64url,
  parseDid,
} from "@clawdentity/protocol";
import { AppError, nowIso } from "@clawdentity/sdk";
import { INVITE_CODE_PREFIX, PEER_ALIAS_PATTERN } from "./constants.js";
import type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorResult,
  OpenclawInvitePayload,
} from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createCliError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    code,
    message,
    status: 400,
    details,
  });
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must be a string",
      {
        label,
      },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INPUT",
      "Input must not be empty",
      {
        label,
      },
    );
  }

  return trimmed;
}

export function parseOptionalProfileName(
  value: unknown,
  label: "agentName" | "humanName",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, label);
}

export function parsePeerAlias(value: unknown): string {
  const alias = parseNonEmptyString(value, "peer alias");
  if (alias.length > 128) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must be at most 128 characters",
    );
  }

  if (!PEER_ALIAS_PATTERN.test(alias)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_PEER_ALIAS",
      "peer alias must use only letters, numbers, dot, underscore, or hyphen",
    );
  }

  return alias;
}

export function parseProxyUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "proxy URL",
    code: "CLI_OPENCLAW_INVALID_PROXY_URL",
    message: "proxy URL must be a valid URL",
  });
}

export function parseHttpUrl(
  value: unknown,
  input: {
    label: string;
    code: string;
    message: string;
  },
): string {
  const candidate = parseNonEmptyString(value, input.label);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw createCliError(input.code, input.message);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw createCliError(input.code, `${input.label} must use http or https`);
  }

  if (
    parsedUrl.pathname === "/" &&
    parsedUrl.search.length === 0 &&
    parsedUrl.hash.length === 0
  ) {
    return parsedUrl.origin;
  }

  return parsedUrl.toString();
}

export function parseOpenclawBaseUrl(value: unknown): string {
  return parseHttpUrl(value, {
    label: "OpenClaw base URL",
    code: "CLI_OPENCLAW_INVALID_OPENCLAW_BASE_URL",
    message: "OpenClaw base URL must be a valid URL",
  });
}

export function parseAgentDid(value: unknown, label: string): string {
  const did = parseNonEmptyString(value, label);

  try {
    const parsed = parseDid(did);
    if (parsed.kind !== "agent") {
      throw createCliError(
        "CLI_OPENCLAW_INVALID_DID",
        "DID is not an agent DID",
      );
    }
  } catch {
    throw createCliError("CLI_OPENCLAW_INVALID_DID", "Agent DID is invalid", {
      label,
    });
  }

  return did;
}

export function parseInvitePayload(value: unknown): OpenclawInvitePayload {
  if (!isRecord(value)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload must be an object",
    );
  }

  if (value.v !== 1) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite payload version is unsupported",
    );
  }

  const issuedAt = parseNonEmptyString(value.issuedAt, "invite issuedAt");
  const did = parseAgentDid(value.did, "invite did");
  const proxyUrl = parseProxyUrl(value.proxyUrl);
  const alias =
    value.alias === undefined ? undefined : parsePeerAlias(value.alias);
  const agentName = parseOptionalProfileName(value.agentName, "agentName");
  const humanName = parseOptionalProfileName(value.humanName, "humanName");

  if (
    alias === undefined &&
    agentName === undefined &&
    humanName === undefined
  ) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
    };
  }

  if (agentName === undefined && humanName === undefined) {
    return {
      v: 1,
      issuedAt,
      did,
      proxyUrl,
      alias,
    };
  }

  return {
    v: 1,
    issuedAt,
    did,
    proxyUrl,
    alias,
    agentName,
    humanName,
  };
}

export function encodeInvitePayload(payload: OpenclawInvitePayload): string {
  const encoded = encodeBase64url(textEncoder.encode(JSON.stringify(payload)));
  return `${INVITE_CODE_PREFIX}${encoded}`;
}

export function decodeInvitePayload(code: string): OpenclawInvitePayload {
  const rawCode = parseNonEmptyString(code, "invite code");
  if (!rawCode.startsWith(INVITE_CODE_PREFIX)) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "Invite code has invalid prefix",
    );
  }

  const encoded = rawCode.slice(INVITE_CODE_PREFIX.length);
  if (encoded.length === 0) {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is empty",
    );
  }

  let decodedJson: string;
  try {
    decodedJson = textDecoder.decode(decodeBase64url(encoded));
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid base64url",
    );
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(decodedJson);
  } catch {
    throw createCliError(
      "CLI_OPENCLAW_INVALID_INVITE",
      "invite code payload is not valid JSON",
    );
  }

  return parseInvitePayload(parsedPayload);
}

export function normalizeStringArrayWithValues(
  value: unknown,
  requiredValues: readonly string[],
): string[] {
  const normalized = new Set<string>();

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }

      const trimmed = item.trim();
      if (trimmed.length > 0) {
        normalized.add(trimmed);
      }
    }
  }

  for (const requiredValue of requiredValues) {
    const trimmed = requiredValue.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return Array.from(normalized);
}

export function parseDoctorPeerAlias(peerAlias?: string): string | undefined {
  if (peerAlias === undefined) {
    return undefined;
  }

  return parsePeerAlias(peerAlias);
}

export function resolveProbeMessage(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity relay probe";
}

export function resolveProbeSessionId(optionValue?: string): string {
  const trimmed = optionValue?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return "clawdentity-relay-test";
}

export function toDoctorCheck(
  input: OpenclawDoctorCheckResult,
): OpenclawDoctorCheckResult {
  return input;
}

export function toDoctorResult(
  checks: OpenclawDoctorCheckResult[],
): OpenclawDoctorResult {
  return {
    status: checks.every((check) => check.status === "pass")
      ? "healthy"
      : "unhealthy",
    checkedAt: nowIso(),
    checks,
  };
}
