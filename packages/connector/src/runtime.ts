import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import {
  decodeBase64url,
  encodeBase64url,
  RELAY_CONNECT_PATH,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
} from "@clawdentity/protocol";
import {
  type AgentAuthBundle,
  AppError,
  createLogger,
  executeWithAgentAuthRefreshRetry,
  type Logger,
  refreshAgentAuthWithClawProof,
  signHttpRequest,
} from "@clawdentity/sdk";
import { WebSocket as NodeWebSocket } from "ws";
import { ConnectorClient, type ConnectorWebSocket } from "./client.js";
import {
  AGENT_ACCESS_HEADER,
  DEFAULT_CONNECTOR_BASE_URL,
  DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_BYTES,
  DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_MESSAGES,
  DEFAULT_CONNECTOR_INBOUND_REPLAY_BATCH_SIZE,
  DEFAULT_CONNECTOR_INBOUND_REPLAY_INTERVAL_MS,
  DEFAULT_CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR,
  DEFAULT_CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS,
  DEFAULT_CONNECTOR_OUTBOUND_PATH,
  DEFAULT_CONNECTOR_STATUS_PATH,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS,
  DEFAULT_OPENCLAW_HOOK_PATH,
} from "./constants.js";
import {
  type ConnectorInboundInboxSnapshot,
  createConnectorInboundInbox,
} from "./inbound-inbox.js";

type ConnectorRuntimeCredentials = {
  accessExpiresAt?: string;
  accessToken?: string;
  agentDid: string;
  ait: string;
  refreshExpiresAt?: string;
  refreshToken: string;
  secretKey: string;
  tokenType?: "Bearer";
};

export type StartConnectorRuntimeInput = {
  agentName: string;
  configDir: string;
  credentials: ConnectorRuntimeCredentials;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  openclawBaseUrl?: string;
  openclawHookPath?: string;
  openclawHookToken?: string;
  outboundBaseUrl?: string;
  outboundPath?: string;
  proxyWebsocketUrl?: string;
  registryUrl: string;
};

export type ConnectorRuntimeHandle = {
  outboundUrl: string;
  stop: () => Promise<void>;
  waitUntilStopped: () => Promise<void>;
  websocketUrl: string;
};

type OutboundRelayRequest = {
  payload: unknown;
  peer: string;
  peerDid: string;
  peerProxyUrl: string;
};

const REGISTRY_AUTH_FILENAME = "registry-auth.json";
const AGENTS_DIR_NAME = "agents";
const REFRESH_SINGLE_FLIGHT_PREFIX = "connector-runtime";
const NONCE_SIZE = 16;
const MAX_OUTBOUND_BODY_BYTES = 1024 * 1024;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toPathWithQuery(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${field}`);
  }

  return value.trim();
}

function normalizeOutboundBaseUrl(baseUrlInput: string | undefined): URL {
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

function normalizeOutboundPath(pathInput: string | undefined): string {
  const raw = pathInput?.trim() || DEFAULT_CONNECTOR_OUTBOUND_PATH;
  if (raw.length === 0) {
    throw new Error("Connector outbound path is invalid");
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeWebSocketUrl(urlInput: string | undefined): string {
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

function resolveOpenclawBaseUrl(input?: string): string {
  const value =
    input?.trim() ||
    process.env.OPENCLAW_BASE_URL?.trim() ||
    DEFAULT_OPENCLAW_BASE_URL;
  return value;
}

function resolveOpenclawHookPath(input?: string): string {
  const value =
    input?.trim() ||
    process.env.OPENCLAW_HOOK_PATH?.trim() ||
    DEFAULT_OPENCLAW_HOOK_PATH;
  return value.startsWith("/") ? value : `/${value}`;
}

function resolveOpenclawHookToken(input?: string): string | undefined {
  const value = input?.trim() || process.env.OPENCLAW_HOOK_TOKEN?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

function toOpenclawHookUrl(baseUrl: string, hookPath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedHookPath = hookPath.startsWith("/")
    ? hookPath.slice(1)
    : hookPath;
  return new URL(normalizedHookPath, normalizedBase).toString();
}

function parsePositiveIntEnv(
  key: string,
  fallback: number,
  minimum = 1,
): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

function sanitizeErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  return error.message.trim().slice(0, 240) || "Unknown error";
}

class LocalOpenclawDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(input: { message: string; retryable: boolean }) {
    super(input.message);
    this.name = "LocalOpenclawDeliveryError";
    this.retryable = input.retryable;
  }
}

type InboundReplayPolicy = {
  batchSize: number;
  inboxMaxBytes: number;
  inboxMaxMessages: number;
  replayIntervalMs: number;
  retryBackoffFactor: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
};

type InboundReplayStatus = {
  lastReplayAt?: string;
  lastReplayError?: string;
  lastAttemptAt?: string;
  lastAttemptStatus?: "ok" | "failed";
  replayerActive: boolean;
};

type InboundReplayView = {
  lastReplayAt?: string;
  lastReplayError?: string;
  pending: ConnectorInboundInboxSnapshot;
  replayerActive: boolean;
  openclawHook: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url: string;
  };
};

function loadInboundReplayPolicy(): InboundReplayPolicy {
  const retryBackoffFactor = Number.parseFloat(
    process.env.CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR ?? "",
  );

  return {
    inboxMaxMessages: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_INBOX_MAX_MESSAGES",
      DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_MESSAGES,
    ),
    inboxMaxBytes: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_INBOX_MAX_BYTES",
      DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_BYTES,
    ),
    replayIntervalMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
      DEFAULT_CONNECTOR_INBOUND_REPLAY_INTERVAL_MS,
    ),
    batchSize: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_REPLAY_BATCH_SIZE",
      DEFAULT_CONNECTOR_INBOUND_REPLAY_BATCH_SIZE,
    ),
    retryInitialDelayMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS",
      DEFAULT_CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS,
    ),
    retryMaxDelayMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS",
      DEFAULT_CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS,
    ),
    retryBackoffFactor:
      Number.isFinite(retryBackoffFactor) && retryBackoffFactor >= 1
        ? retryBackoffFactor
        : DEFAULT_CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR,
  };
}

function computeReplayDelayMs(input: {
  attemptCount: number;
  policy: InboundReplayPolicy;
}): number {
  const exponent = Math.max(0, input.attemptCount - 1);
  const delay = Math.min(
    input.policy.retryMaxDelayMs,
    Math.floor(
      input.policy.retryInitialDelayMs *
        input.policy.retryBackoffFactor ** exponent,
    ),
  );
  return Math.max(1, delay);
}

async function deliverToOpenclawHook(input: {
  fetchImpl: typeof fetch;
  openclawHookToken?: string;
  openclawHookUrl: string;
  payload: unknown;
  requestId: string;
}): Promise<void> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, DEFAULT_OPENCLAW_DELIVER_TIMEOUT_MS);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": input.requestId,
  };
  if (input.openclawHookToken !== undefined) {
    headers["x-openclaw-token"] = input.openclawHookToken;
  }

  try {
    const response = await input.fetchImpl(input.openclawHookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new LocalOpenclawDeliveryError({
        message: `Local OpenClaw hook rejected payload with status ${response.status}`,
        retryable:
          response.status >= 500 ||
          response.status === 404 ||
          response.status === 429,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LocalOpenclawDeliveryError({
        message: "Local OpenClaw hook request timed out",
        retryable: true,
      });
    }
    if (error instanceof LocalOpenclawDeliveryError) {
      throw error;
    }
    throw new LocalOpenclawDeliveryError({
      message: sanitizeErrorReason(error),
      retryable: true,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function toInitialAuthBundle(
  credentials: ConnectorRuntimeCredentials,
): AgentAuthBundle {
  return {
    tokenType: "Bearer",
    accessToken: credentials.accessToken?.trim() || "",
    accessExpiresAt:
      credentials.accessExpiresAt?.trim() || "1970-01-01T00:00:00.000Z",
    refreshToken: parseRequiredString(credentials.refreshToken, "refreshToken"),
    refreshExpiresAt:
      credentials.refreshExpiresAt?.trim() || "2100-01-01T00:00:00.000Z",
  };
}

function parseIsoTimestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function shouldRefreshAccessToken(
  auth: AgentAuthBundle,
  nowMs: number,
): boolean {
  if (auth.accessToken.trim().length === 0) {
    return true;
  }

  const expiresAtMs = parseIsoTimestampMs(auth.accessExpiresAt);
  if (expiresAtMs === undefined) {
    return false;
  }

  return expiresAtMs <= nowMs + ACCESS_TOKEN_REFRESH_SKEW_MS;
}

function parseOutboundRelayRequest(payload: unknown): OutboundRelayRequest {
  if (!isRecord(payload)) {
    throw new AppError({
      code: "CONNECTOR_OUTBOUND_INVALID_REQUEST",
      message: "Outbound relay request must be an object",
      status: 400,
      expose: true,
    });
  }

  return {
    peer: parseRequiredString(payload.peer, "peer"),
    peerDid: parseRequiredString(payload.peerDid, "peerDid"),
    peerProxyUrl: parseRequiredString(payload.peerProxyUrl, "peerProxyUrl"),
    payload: payload.payload,
  };
}

function createWebSocketFactory(): (
  url: string,
  headers: Record<string, string>,
) => ConnectorWebSocket {
  return (url: string, headers: Record<string, string>) => {
    const socket = new NodeWebSocket(url, {
      headers,
    });

    return {
      get readyState() {
        return socket.readyState;
      },
      send: (data: string) => {
        socket.send(data);
      },
      close: (code?: number, reason?: string) => {
        socket.close(code, reason);
      },
      addEventListener: (type, listener) => {
        if (type === "open") {
          socket.on("open", () => listener({}));
          return;
        }

        if (type === "message") {
          socket.on("message", (data) => {
            const text =
              typeof data === "string"
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data).toString("utf8")
                  : Buffer.isBuffer(data)
                    ? data.toString("utf8")
                    : Buffer.from(data).toString("utf8");
            listener({ data: text });
          });
          return;
        }

        if (type === "close") {
          socket.on("close", (code, reason) => {
            listener({
              code: Number(code),
              reason: reason.toString("utf8"),
              wasClean: Number(code) === 1000,
            });
          });
          return;
        }

        if (type === "unexpected-response") {
          socket.on("unexpected-response", (_request, response) => {
            listener({
              status: response.statusCode,
            });
          });
          return;
        }

        socket.on("error", (error) => listener({ error }));
      },
    };
  };
}

async function writeRegistryAuthAtomic(input: {
  auth: AgentAuthBundle;
  configDir: string;
  agentName: string;
}): Promise<void> {
  const targetPath = join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    REGISTRY_AUTH_FILENAME,
  );
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(input.auth, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

function parseRegistryAuthFromDisk(
  payload: unknown,
): AgentAuthBundle | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const tokenType = payload.tokenType;
  const accessToken = payload.accessToken;
  const accessExpiresAt = payload.accessExpiresAt;
  const refreshToken = payload.refreshToken;
  const refreshExpiresAt = payload.refreshExpiresAt;

  if (
    tokenType !== "Bearer" ||
    typeof accessToken !== "string" ||
    typeof accessExpiresAt !== "string" ||
    typeof refreshToken !== "string" ||
    typeof refreshExpiresAt !== "string"
  ) {
    return undefined;
  }

  return {
    tokenType,
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

async function readRegistryAuthFromDisk(input: {
  configDir: string;
  agentName: string;
  logger: Logger;
}): Promise<AgentAuthBundle | undefined> {
  const authPath = join(
    input.configDir,
    AGENTS_DIR_NAME,
    input.agentName,
    REGISTRY_AUTH_FILENAME,
  );

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return undefined;
    }

    input.logger.warn("connector.runtime.registry_auth_read_failed", {
      authPath,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    input.logger.warn("connector.runtime.registry_auth_invalid_json", {
      authPath,
    });
    return undefined;
  }

  const auth = parseRegistryAuthFromDisk(parsed);
  if (auth === undefined) {
    input.logger.warn("connector.runtime.registry_auth_invalid_shape", {
      authPath,
    });
  }
  return auth;
}

async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += next.length;
    if (totalBytes > MAX_OUTBOUND_BODY_BYTES) {
      throw new AppError({
        code: "CONNECTOR_OUTBOUND_TOO_LARGE",
        message: "Outbound relay payload too large",
        status: 413,
        expose: true,
      });
    }
    chunks.push(next);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (bodyText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new AppError({
      code: "CONNECTOR_OUTBOUND_INVALID_JSON",
      message: "Outbound relay payload must be valid JSON",
      status: 400,
      expose: true,
    });
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

function isRetryableRelayAuthError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "OPENCLAW_RELAY_AGENT_AUTH_REJECTED" &&
    error.status === 401
  );
}

async function buildUpgradeHeaders(input: {
  ait: string;
  accessToken: string;
  wsUrl: URL;
  secretKey: Uint8Array;
}): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = encodeBase64url(randomBytes(NONCE_SIZE));
  const signed = await signHttpRequest({
    method: "GET",
    pathWithQuery: toPathWithQuery(input.wsUrl),
    timestamp,
    nonce,
    secretKey: input.secretKey,
  });

  return {
    authorization: `Claw ${input.ait}`,
    [AGENT_ACCESS_HEADER]: input.accessToken,
    ...signed.headers,
  };
}

export async function startConnectorRuntime(
  input: StartConnectorRuntimeInput,
): Promise<ConnectorRuntimeHandle> {
  const logger =
    input.logger ?? createLogger({ service: "connector", module: "runtime" });
  const fetchImpl = input.fetchImpl ?? fetch;

  const secretKey = decodeBase64url(
    parseRequiredString(input.credentials.secretKey, "secretKey"),
  );

  let currentAuth = toInitialAuthBundle(input.credentials);

  const syncAuthFromDisk = async (): Promise<void> => {
    const diskAuth = await readRegistryAuthFromDisk({
      configDir: input.configDir,
      agentName: input.agentName,
      logger,
    });
    if (!diskAuth) {
      return;
    }

    if (
      diskAuth.accessToken === currentAuth.accessToken &&
      diskAuth.accessExpiresAt === currentAuth.accessExpiresAt &&
      diskAuth.refreshToken === currentAuth.refreshToken &&
      diskAuth.refreshExpiresAt === currentAuth.refreshExpiresAt
    ) {
      return;
    }

    currentAuth = diskAuth;
    logger.info("connector.runtime.registry_auth_synced", {
      agentName: input.agentName,
    });
  };

  const refreshCurrentAuthIfNeeded = async (): Promise<void> => {
    await syncAuthFromDisk();
    if (!shouldRefreshAccessToken(currentAuth, Date.now())) {
      return;
    }

    await refreshCurrentAuth();
  };

  const refreshCurrentAuth = async (): Promise<void> => {
    currentAuth = await refreshAgentAuthWithClawProof({
      registryUrl: input.registryUrl,
      ait: input.credentials.ait,
      secretKey,
      refreshToken: currentAuth.refreshToken,
      fetchImpl,
    });
    await writeRegistryAuthAtomic({
      configDir: input.configDir,
      agentName: input.agentName,
      auth: currentAuth,
    });
  };

  await refreshCurrentAuthIfNeeded();

  const wsUrl = normalizeWebSocketUrl(input.proxyWebsocketUrl);
  const wsParsed = new URL(wsUrl);
  const openclawBaseUrl = resolveOpenclawBaseUrl(input.openclawBaseUrl);
  const openclawHookPath = resolveOpenclawHookPath(input.openclawHookPath);
  const openclawHookToken = resolveOpenclawHookToken(input.openclawHookToken);
  const openclawHookUrl = toOpenclawHookUrl(openclawBaseUrl, openclawHookPath);
  const inboundReplayPolicy = loadInboundReplayPolicy();
  const inboundInbox = createConnectorInboundInbox({
    configDir: input.configDir,
    agentName: input.agentName,
    maxPendingMessages: inboundReplayPolicy.inboxMaxMessages,
    maxPendingBytes: inboundReplayPolicy.inboxMaxBytes,
  });
  const inboundReplayStatus: InboundReplayStatus = {
    replayerActive: false,
  };
  let runtimeStopping = false;
  let replayInFlight = false;
  let replayIntervalHandle: ReturnType<typeof setInterval> | undefined;

  const resolveUpgradeHeaders = async (): Promise<Record<string, string>> => {
    await refreshCurrentAuthIfNeeded();
    return buildUpgradeHeaders({
      wsUrl: wsParsed,
      ait: input.credentials.ait,
      accessToken: currentAuth.accessToken,
      secretKey,
    });
  };

  const replayPendingInboundMessages = async (): Promise<void> => {
    if (runtimeStopping || replayInFlight) {
      return;
    }

    replayInFlight = true;
    inboundReplayStatus.replayerActive = true;

    try {
      const dueItems = await inboundInbox.listDuePending({
        nowMs: Date.now(),
        limit: inboundReplayPolicy.batchSize,
      });
      for (const pending of dueItems) {
        inboundReplayStatus.lastAttemptAt = new Date().toISOString();
        try {
          await deliverToOpenclawHook({
            fetchImpl,
            openclawHookUrl,
            openclawHookToken,
            requestId: pending.requestId,
            payload: pending.payload,
          });
          await inboundInbox.markDelivered(pending.requestId);
          inboundReplayStatus.lastReplayAt = new Date().toISOString();
          inboundReplayStatus.lastReplayError = undefined;
          inboundReplayStatus.lastAttemptStatus = "ok";
          logger.info("connector.inbound.replay_succeeded", {
            requestId: pending.requestId,
            attemptCount: pending.attemptCount + 1,
          });
        } catch (error) {
          const reason = sanitizeErrorReason(error);
          const retryable =
            error instanceof LocalOpenclawDeliveryError
              ? error.retryable
              : true;
          const nextAttemptAt = new Date(
            Date.now() +
              computeReplayDelayMs({
                attemptCount: pending.attemptCount + 1,
                policy: inboundReplayPolicy,
              }) *
                (retryable ? 1 : 10),
          ).toISOString();
          await inboundInbox.markReplayFailure({
            requestId: pending.requestId,
            errorMessage: reason,
            nextAttemptAt,
          });
          inboundReplayStatus.lastReplayError = reason;
          inboundReplayStatus.lastAttemptStatus = "failed";
          logger.warn("connector.inbound.replay_failed", {
            requestId: pending.requestId,
            attemptCount: pending.attemptCount + 1,
            retryable,
            nextAttemptAt,
            reason,
          });
        }
      }
    } finally {
      replayInFlight = false;
      inboundReplayStatus.replayerActive = false;
    }
  };

  const readInboundReplayView = async (): Promise<InboundReplayView> => {
    const pending = await inboundInbox.getSnapshot();
    return {
      pending,
      replayerActive: inboundReplayStatus.replayerActive || replayInFlight,
      lastReplayAt: inboundReplayStatus.lastReplayAt,
      lastReplayError: inboundReplayStatus.lastReplayError,
      openclawHook: {
        url: openclawHookUrl,
        lastAttemptAt: inboundReplayStatus.lastAttemptAt,
        lastAttemptStatus: inboundReplayStatus.lastAttemptStatus,
      },
    };
  };

  const connectorClient = new ConnectorClient({
    connectorUrl: wsParsed.toString(),
    connectionHeadersProvider: resolveUpgradeHeaders,
    openclawBaseUrl,
    openclawHookPath,
    openclawHookToken,
    fetchImpl,
    logger,
    hooks: {
      onAuthUpgradeRejected: async ({ status, immediateRetry }) => {
        logger.warn("connector.websocket.auth_upgrade_rejected", {
          status,
          immediateRetry,
        });
        await syncAuthFromDisk();
        try {
          await refreshCurrentAuth();
        } catch (error) {
          logger.warn(
            "connector.runtime.registry_auth_refresh_on_ws_upgrade_reject_failed",
            {
              reason: sanitizeErrorReason(error),
            },
          );
        }
      },
    },
    inboundDeliverHandler: async (frame) => {
      const persisted = await inboundInbox.enqueue(frame);
      if (!persisted.accepted) {
        logger.warn("connector.inbound.persist_rejected", {
          requestId: frame.id,
          reason: persisted.reason ?? "inbox limit reached",
          pendingCount: persisted.pendingCount,
        });
        return {
          accepted: false,
          reason: persisted.reason,
        };
      }

      logger.info("connector.inbound.persisted", {
        requestId: frame.id,
        duplicate: persisted.duplicate,
        pendingCount: persisted.pendingCount,
      });
      void replayPendingInboundMessages();
      return { accepted: true };
    },
    webSocketFactory: createWebSocketFactory(),
  });

  const outboundBaseUrl = normalizeOutboundBaseUrl(input.outboundBaseUrl);
  const outboundPath = normalizeOutboundPath(input.outboundPath);
  const statusPath = DEFAULT_CONNECTOR_STATUS_PATH;
  const outboundUrl = new URL(outboundPath, outboundBaseUrl).toString();

  const relayToPeer = async (request: OutboundRelayRequest): Promise<void> => {
    await syncAuthFromDisk();
    const peerUrl = new URL(request.peerProxyUrl);
    const body = JSON.stringify(request.payload ?? {});
    const refreshKey = `${REFRESH_SINGLE_FLIGHT_PREFIX}:${input.configDir}:${input.agentName}`;

    const performRelay = async (auth: AgentAuthBundle): Promise<void> => {
      const unixSeconds = Math.floor(Date.now() / 1000).toString();
      const nonce = encodeBase64url(randomBytes(NONCE_SIZE));
      const signed = await signHttpRequest({
        method: "POST",
        pathWithQuery: toPathWithQuery(peerUrl),
        timestamp: unixSeconds,
        nonce,
        body: new TextEncoder().encode(body),
        secretKey,
      });

      const response = await fetchImpl(peerUrl.toString(), {
        method: "POST",
        headers: {
          Authorization: `Claw ${input.credentials.ait}`,
          "Content-Type": "application/json",
          [AGENT_ACCESS_HEADER]: auth.accessToken,
          [RELAY_RECIPIENT_AGENT_DID_HEADER]: request.peerDid,
          ...signed.headers,
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new AppError({
            code: "OPENCLAW_RELAY_AGENT_AUTH_REJECTED",
            message: "Peer relay rejected agent auth credentials",
            status: 401,
            expose: true,
          });
        }

        throw new AppError({
          code: "CONNECTOR_OUTBOUND_DELIVERY_FAILED",
          message: "Peer relay request failed",
          status: 502,
        });
      }
    };

    await executeWithAgentAuthRefreshRetry({
      key: refreshKey,
      shouldRetry: isRetryableRelayAuthError,
      getAuth: async () => {
        await syncAuthFromDisk();
        return currentAuth;
      },
      persistAuth: async (nextAuth) => {
        currentAuth = nextAuth;
        await writeRegistryAuthAtomic({
          configDir: input.configDir,
          agentName: input.agentName,
          auth: nextAuth,
        });
      },
      refreshAuth: async (auth) =>
        refreshAgentAuthWithClawProof({
          registryUrl: input.registryUrl,
          ait: input.credentials.ait,
          secretKey,
          refreshToken: auth.refreshToken,
          fetchImpl,
        }),
      perform: performRelay,
    });
  };

  const server = createServer(async (req, res) => {
    const requestPath = req.url
      ? new URL(req.url, outboundBaseUrl).pathname
      : "/";

    if (requestPath === statusPath) {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        writeJson(res, 405, { error: "Method Not Allowed" });
        return;
      }

      let inboundReplayView: InboundReplayView;
      try {
        inboundReplayView = await readInboundReplayView();
      } catch (error) {
        logger.warn("connector.status.inbound_inbox_unavailable", {
          reason: sanitizeErrorReason(error),
        });
        writeJson(res, 500, {
          status: "error",
          error: {
            code: "CONNECTOR_INBOUND_INBOX_UNAVAILABLE",
            message: "Connector inbound inbox status is unavailable",
          },
          outboundUrl,
          websocketUrl: wsUrl,
          websocketConnected: connectorClient.isConnected(),
        });
        return;
      }
      writeJson(res, 200, {
        status: "ok",
        outboundUrl,
        websocketUrl: wsUrl,
        websocketConnected: connectorClient.isConnected(),
        inboundInbox: {
          pendingCount: inboundReplayView.pending.pendingCount,
          pendingBytes: inboundReplayView.pending.pendingBytes,
          oldestPendingAt: inboundReplayView.pending.oldestPendingAt,
          nextAttemptAt: inboundReplayView.pending.nextAttemptAt,
          replayerActive: inboundReplayView.replayerActive,
          lastReplayAt: inboundReplayView.lastReplayAt,
          lastReplayError: inboundReplayView.lastReplayError,
        },
        openclawHook: inboundReplayView.openclawHook,
      });
      return;
    }

    if (requestPath !== outboundPath) {
      writeJson(res, 404, { error: "Not Found" });
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST");
      writeJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    try {
      const requestBody = await readRequestJson(req);
      const relayRequest = parseOutboundRelayRequest(requestBody);
      await relayToPeer(relayRequest);
      writeJson(res, 202, { accepted: true, peer: relayRequest.peer });
    } catch (error) {
      if (error instanceof AppError) {
        logger.warn("connector.outbound.rejected", {
          code: error.code,
          status: error.status,
          message: error.message,
        });
        writeJson(res, error.status, {
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      logger.error("connector.outbound.failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      writeJson(res, 500, {
        error: {
          code: "CONNECTOR_OUTBOUND_INTERNAL",
          message: "Connector outbound relay failed",
        },
      });
    }
  });

  let stoppedResolve: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    stoppedResolve = resolve;
  });

  const stop = async (): Promise<void> => {
    runtimeStopping = true;
    if (replayIntervalHandle !== undefined) {
      clearInterval(replayIntervalHandle);
      replayIntervalHandle = undefined;
    }
    connectorClient.disconnect();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    stoppedResolve?.();
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      Number(outboundBaseUrl.port || "80"),
      outboundBaseUrl.hostname,
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });

  connectorClient.connect();
  await inboundInbox.pruneDelivered();
  void replayPendingInboundMessages();
  replayIntervalHandle = setInterval(() => {
    void replayPendingInboundMessages();
  }, inboundReplayPolicy.replayIntervalMs);

  logger.info("connector.runtime.started", {
    outboundUrl,
    websocketUrl: wsUrl,
    agentDid: input.credentials.agentDid,
  });

  return {
    outboundUrl,
    websocketUrl: wsUrl,
    stop,
    waitUntilStopped: async () => stoppedPromise,
  };
}
