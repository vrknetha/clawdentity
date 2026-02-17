import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import {
  decodeBase64url,
  encodeBase64url,
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
  DEFAULT_CONNECTOR_OUTBOUND_PATH,
  DEFAULT_OPENCLAW_BASE_URL,
  DEFAULT_OPENCLAW_HOOK_PATH,
} from "./constants.js";

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

  if (shouldRefreshAccessToken(currentAuth, Date.now())) {
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
  }

  const wsUrl = normalizeWebSocketUrl(input.proxyWebsocketUrl);
  const wsParsed = new URL(wsUrl);
  const upgradeHeaders = await buildUpgradeHeaders({
    wsUrl: wsParsed,
    ait: input.credentials.ait,
    accessToken: currentAuth.accessToken,
    secretKey,
  });

  const connectorClient = new ConnectorClient({
    connectorUrl: wsParsed.toString(),
    connectionHeaders: upgradeHeaders,
    openclawBaseUrl: resolveOpenclawBaseUrl(input.openclawBaseUrl),
    openclawHookPath: resolveOpenclawHookPath(input.openclawHookPath),
    openclawHookToken: resolveOpenclawHookToken(input.openclawHookToken),
    fetchImpl,
    logger,
    webSocketFactory: createWebSocketFactory(),
  });

  const outboundBaseUrl = normalizeOutboundBaseUrl(input.outboundBaseUrl);
  const outboundPath = normalizeOutboundPath(input.outboundPath);
  const outboundUrl = new URL(outboundPath, outboundBaseUrl).toString();

  const relayToPeer = async (request: OutboundRelayRequest): Promise<void> => {
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
      getAuth: async () => currentAuth,
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
