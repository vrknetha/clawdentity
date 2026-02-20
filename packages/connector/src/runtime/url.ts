import { toOpenclawHookUrl as toResolvedOpenclawHookUrl } from "@clawdentity/common";
import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import {
  DEFAULT_CONNECTOR_BASE_URL,
  DEFAULT_CONNECTOR_OUTBOUND_PATH,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_OPENCLAW_HOOK_PATH,
} from "../constants.js";

export function toPathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}

export function normalizeOutboundBaseUrl(
  baseUrlInput: string | undefined,
): URL {
  const raw = baseUrlInput?.trim() || DEFAULT_CONNECTOR_BASE_URL;
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Connector outbound base URL is invalid");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Connector outbound base URL must use http://");
  }

  return parsed;
}

export function normalizeOutboundPath(pathInput: string | undefined): string {
  const raw = pathInput?.trim() || DEFAULT_CONNECTOR_OUTBOUND_PATH;
  if (raw.length === 0) {
    throw new Error("Connector outbound path is invalid");
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function normalizeWebSocketUrl(urlInput: string | undefined): string {
  const raw = urlInput?.trim() ?? process.env.CLAWDENTITY_PROXY_WS_URL?.trim();
  if (!raw) {
    throw new Error(
      "Proxy websocket URL is required (set --proxy-ws-url or CLAWDENTITY_PROXY_WS_URL)",
    );
  }

  const parsed = new URL(raw);
  if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  }

  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error("Proxy websocket URL must use ws:// or wss://");
  }

  if (parsed.pathname === "/") {
    parsed.pathname = RELAY_CONNECT_PATH;
  }

  return parsed.toString();
}

export function resolveOpenclawBaseUrl(input?: string): string {
  return (
    input?.trim() ||
    process.env.OPENCLAW_BASE_URL?.trim() ||
    DEFAULT_OPENCLAW_BASE_URL
  );
}

export function resolveOpenclawHookPath(input?: string): string {
  const value =
    input?.trim() ||
    process.env.OPENCLAW_HOOK_PATH?.trim() ||
    DEFAULT_OPENCLAW_HOOK_PATH;
  return value.startsWith("/") ? value : `/${value}`;
}

export function resolveOpenclawHookToken(input?: string): string | undefined {
  const value = input?.trim() || process.env.OPENCLAW_HOOK_TOKEN?.trim();
  if (!value) {
    return undefined;
  }

  return value;
}

export function toOpenclawHookUrl(baseUrl: string, hookPath: string): string {
  return toResolvedOpenclawHookUrl(baseUrl, hookPath);
}

export function toHttpOriginFromWebSocketUrl(value: URL): string {
  const normalized = new URL(value.toString());
  if (normalized.protocol === "wss:") {
    normalized.protocol = "https:";
  } else if (normalized.protocol === "ws:") {
    normalized.protocol = "http:";
  }

  return normalized.origin;
}
