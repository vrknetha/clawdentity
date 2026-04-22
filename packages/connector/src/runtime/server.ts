import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "@clawdentity/sdk";
import type { ConnectorClient } from "../client.js";
import { DEFAULT_CONNECTOR_STATUS_PATH } from "../constants.js";
import type { ConnectorInboundInbox } from "../inbound-inbox.js";
import {
  CONNECTOR_DEAD_LETTER_PATH,
  CONNECTOR_DEAD_LETTER_PURGE_PATH,
  CONNECTOR_DEAD_LETTER_REPLAY_PATH,
} from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";
import {
  parseOutboundRelayRequest,
  readRequestJson,
  writeJson,
} from "./http.js";
import { isRecord, parseRequestIds } from "./parse.js";
import type { InboundReplayView } from "./types.js";

type RuntimeRequestHandlerInput = {
  connectorClient: ConnectorClient;
  inboundInbox: ConnectorInboundInbox;
  logger: {
    error: (event: string, payload?: Record<string, unknown>) => void;
    warn: (event: string, payload?: Record<string, unknown>) => void;
  };
  outboundBaseUrl: URL;
  outboundPath: string;
  outboundUrl: string;
  readInboundReplayView: () => Promise<InboundReplayView>;
  relayToPeer: (
    request: ReturnType<typeof parseOutboundRelayRequest>,
  ) => Promise<void>;
  replayPendingInboundMessages: () => void;
  wsUrl: string;
};

export function isLoopbackRemoteAddress(
  remoteAddress: string | undefined,
): boolean {
  const normalized = remoteAddress?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

function sanitizeStatusUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function createRuntimeRequestHandler(
  input: RuntimeRequestHandlerInput,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const sanitizedOutboundUrl = sanitizeStatusUrl(input.outboundUrl);
  const sanitizedWebsocketUrl = sanitizeStatusUrl(input.wsUrl);

  return async (req, res) => {
    const requestPath = req.url
      ? new URL(req.url, input.outboundBaseUrl).pathname
      : "/";

    if (requestPath === DEFAULT_CONNECTOR_STATUS_PATH) {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        writeJson(res, 405, { error: "Method Not Allowed" });
        return;
      }

      let inboundReplayView: InboundReplayView;
      try {
        inboundReplayView = await input.readInboundReplayView();
      } catch (error) {
        input.logger.warn("connector.status.inbound_inbox_unavailable", {
          reason: sanitizeErrorReason(error),
        });
        writeJson(res, 500, {
          status: "error",
          error: {
            code: "CONNECTOR_INBOUND_INBOX_UNAVAILABLE",
            message: "Connector inbound inbox status is unavailable",
          },
          outboundUrl: sanitizedOutboundUrl,
          websocketUrl: sanitizedWebsocketUrl,
          websocket: {
            connected: input.connectorClient.isConnected(),
          },
        });
        return;
      }
      const clientMetrics = input.connectorClient.getMetricsSnapshot();
      writeJson(res, 200, {
        status: "ok",
        outboundUrl: sanitizedOutboundUrl,
        websocketUrl: sanitizedWebsocketUrl,
        websocket: {
          ...clientMetrics.connection,
        },
        inbound: {
          pending: inboundReplayView.snapshot.pending,
          deadLetter: inboundReplayView.snapshot.deadLetter,
          replay: {
            replayerActive: inboundReplayView.replayerActive,
            lastReplayAt: inboundReplayView.lastReplayAt,
            lastReplayError: inboundReplayView.lastReplayError,
          },
          deliveryWebhookGateway: inboundReplayView.deliveryWebhookGateway,
          deliveryWebhookHook: inboundReplayView.deliveryWebhookHook,
        },
        outbound: {
          queue: {
            pendingCount: input.connectorClient.getQueuedOutboundCount(),
          },
        },
        metrics: {
          heartbeat: clientMetrics.heartbeat,
          inboundDelivery: clientMetrics.inboundDelivery,
          outboundQueue: clientMetrics.outboundQueue,
        },
      });
      return;
    }

    if (requestPath === CONNECTOR_DEAD_LETTER_PATH) {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        writeJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        writeJson(res, 403, {
          error: {
            code: "CONNECTOR_ADMIN_FORBIDDEN",
            message:
              "Dead-letter admin endpoints are restricted to loopback clients",
          },
        });
        return;
      }

      const deadLetterItems = await input.inboundInbox.listDeadLetter();
      writeJson(res, 200, {
        status: "ok",
        count: deadLetterItems.length,
        items: deadLetterItems,
      });
      return;
    }

    if (requestPath === CONNECTOR_DEAD_LETTER_REPLAY_PATH) {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        writeJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        writeJson(res, 403, {
          error: {
            code: "CONNECTOR_ADMIN_FORBIDDEN",
            message:
              "Dead-letter admin endpoints are restricted to loopback clients",
          },
        });
        return;
      }

      const body = await readRequestJson(req);
      const requestIds = isRecord(body)
        ? parseRequestIds(body.requestIds)
        : undefined;
      const replayResult = await input.inboundInbox.replayDeadLetter({
        requestIds,
      });
      input.replayPendingInboundMessages();
      writeJson(res, 200, {
        status: "ok",
        replayedCount: replayResult.replayedCount,
      });
      return;
    }

    if (requestPath === CONNECTOR_DEAD_LETTER_PURGE_PATH) {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        writeJson(res, 405, { error: "Method Not Allowed" });
        return;
      }
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        writeJson(res, 403, {
          error: {
            code: "CONNECTOR_ADMIN_FORBIDDEN",
            message:
              "Dead-letter admin endpoints are restricted to loopback clients",
          },
        });
        return;
      }

      const body = await readRequestJson(req);
      const requestIds = isRecord(body)
        ? parseRequestIds(body.requestIds)
        : undefined;
      const purgeResult = await input.inboundInbox.purgeDeadLetter({
        requestIds,
      });
      writeJson(res, 200, {
        status: "ok",
        purgedCount: purgeResult.purgedCount,
      });
      return;
    }

    if (requestPath !== input.outboundPath) {
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
      await input.relayToPeer(relayRequest);
      writeJson(res, 202, { accepted: true, peer: relayRequest.peer });
    } catch (error) {
      if (error instanceof AppError) {
        input.logger.warn("connector.outbound.rejected", {
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

      input.logger.error("connector.outbound.failed", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      writeJson(res, 500, {
        error: {
          code: "CONNECTOR_OUTBOUND_INTERNAL",
          message: "Connector outbound relay failed",
        },
      });
    }
  };
}
