import { AppError } from "@clawdentity/sdk";
import type { ConnectorServicePlatform } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
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

export function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_INPUT",
      "Connector input is invalid",
      {
        label,
      },
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_INPUT",
      "Connector input is invalid",
      {
        label,
      },
    );
  }

  return trimmed;
}

export function parseAgentDid(value: unknown): string {
  const did = parseNonEmptyString(value, "agent did");
  if (!did.startsWith("did:claw:agent:")) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_AGENT_IDENTITY",
      "Agent identity is invalid for connector startup",
    );
  }

  return did;
}

export function parseConnectorBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_BASE_URL",
      "Connector base URL is invalid",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_BASE_URL",
      "Connector base URL is invalid",
    );
  }

  if (
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  ) {
    return parsed.origin;
  }

  return parsed.toString();
}

export function parseProxyWebsocketUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_PROXY_URL",
      "Proxy websocket URL is invalid",
    );
  }

  if (
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:" &&
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_PROXY_URL",
      "Proxy websocket URL is invalid",
    );
  }

  return parsed.toString();
}

export function normalizeOutboundPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed.length === 0) {
    throw createCliError(
      "CLI_CONNECTOR_INVALID_OUTBOUND_PATH",
      "Connector outbound path is invalid",
    );
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function parseJsonRecord(
  value: string,
  code: string,
  message: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw createCliError(code, message);
  }

  if (!isRecord(parsed)) {
    throw createCliError(code, message);
  }

  return parsed;
}

export function sanitizeServiceSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_.-]+/g, "-");
}

export function parseConnectorServicePlatformOption(
  value: unknown,
): "auto" | ConnectorServicePlatform {
  if (value === undefined) {
    return "auto";
  }

  if (value === "auto" || value === "launchd" || value === "systemd") {
    return value;
  }

  throw createCliError(
    "CLI_CONNECTOR_SERVICE_PLATFORM_INVALID",
    "Connector service platform must be one of: auto, launchd, systemd",
  );
}

export function resolveConnectorServicePlatform(
  inputPlatform: "auto" | ConnectorServicePlatform | undefined,
  currentPlatform: NodeJS.Platform,
): ConnectorServicePlatform {
  if (inputPlatform && inputPlatform !== "auto") {
    return inputPlatform;
  }

  if (currentPlatform === "darwin") {
    return "launchd";
  }

  if (currentPlatform === "linux") {
    return "systemd";
  }

  throw createCliError(
    "CLI_CONNECTOR_SERVICE_PLATFORM_UNSUPPORTED",
    "Connector service install is supported only on macOS (launchd) and Linux (systemd)",
    {
      platform: currentPlatform,
    },
  );
}
