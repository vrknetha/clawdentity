import type { Logger } from "@clawdentity/sdk";
import { WS_READY_STATE_OPEN } from "../constants.js";
import {
  normalizeConnectionHeaders,
  readCloseEvent,
  readErrorEventReason,
  readMessageEventData,
  sanitizeErrorReason,
  WS_READY_STATE_CONNECTING,
} from "./helpers.js";
import type { ConnectorClientMetricsTracker } from "./metrics.js";
import type { ConnectorReconnectScheduler } from "./reconnect-scheduler.js";
import type { ConnectorClientHooks, ConnectorWebSocket } from "./types.js";

export async function resolveConnectorConnectionHeaders(input: {
  baseHeaders: Record<string, string>;
  provider:
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  logger: Logger;
}): Promise<Record<string, string> | undefined> {
  if (input.provider === undefined) {
    return input.baseHeaders;
  }

  try {
    return normalizeConnectionHeaders(await input.provider());
  } catch (error) {
    input.logger.warn("connector.websocket.create_failed", {
      reason: sanitizeErrorReason(error),
    });
    return undefined;
  }
}

export function closeConnectorSocketQuietly(input: {
  socket: ConnectorWebSocket;
  logger: Logger;
  code?: number;
  reason?: string;
}): void {
  try {
    input.socket.close(input.code, input.reason);
  } catch (error) {
    input.logger.warn("connector.websocket.close_failed", {
      reason: sanitizeErrorReason(error),
    });
  }
}

export function createConnectorSocketEventHandlers(input: {
  socket: ConnectorWebSocket;
  connectorUrl: string;
  hooks: ConnectorClientHooks;
  logger: Logger;
  metricsTracker: ConnectorClientMetricsTracker;
  reconnectScheduler: ConnectorReconnectScheduler;
  clearConnectTimeout: () => void;
  startHeartbeatInterval: () => void;
  flushOutboundQueue: () => void;
  isCurrentSocket: (socket: ConnectorWebSocket) => boolean;
  detachSocket: (socket: ConnectorWebSocket) => boolean;
  closeSocketQuietly: (
    socket: ConnectorWebSocket,
    code?: number,
    reason?: string,
  ) => void;
  onIncomingMessage: (rawFrame: unknown) => Promise<void>;
  onUnexpectedResponse: (
    socket: ConnectorWebSocket,
    event: unknown,
  ) => Promise<void>;
  isStarted: () => boolean;
  scheduleReconnect: (options?: {
    delayMs?: number;
    incrementAttempt?: boolean;
  }) => void;
  makeTimestamp: () => string;
  onConnected: () => void;
}) {
  const socket = input.socket;

  return {
    onOpen: () => {
      if (!input.isCurrentSocket(socket)) {
        return;
      }

      input.clearConnectTimeout();
      input.reconnectScheduler.resetAttempts();
      input.metricsTracker.onSocketConnected(input.makeTimestamp());
      input.logger.info("connector.websocket.connected", {
        url: input.connectorUrl,
      });
      input.startHeartbeatInterval();
      input.flushOutboundQueue();
      input.hooks.onConnected?.();
      input.onConnected();
    },
    onMessage: (event: unknown) => {
      if (!input.isCurrentSocket(socket)) {
        return;
      }

      void input.onIncomingMessage(readMessageEventData(event));
    },
    onClose: (event: unknown) => {
      if (!input.detachSocket(socket)) {
        return;
      }

      const closeEvent = readCloseEvent(event);

      input.logger.warn("connector.websocket.closed", {
        closeCode: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });

      input.hooks.onDisconnected?.({
        code: closeEvent.code,
        reason: closeEvent.reason,
        wasClean: closeEvent.wasClean,
      });

      if (input.isStarted()) {
        input.scheduleReconnect();
      }
    },
    onError: (event: unknown) => {
      if (!input.isCurrentSocket(socket)) {
        return;
      }

      const readyState = socket.readyState;
      const shouldForceReconnect =
        readyState !== WS_READY_STATE_OPEN &&
        readyState !== WS_READY_STATE_CONNECTING;
      if (!shouldForceReconnect) {
        input.logger.warn("connector.websocket.error", {
          url: input.connectorUrl,
          reason: readErrorEventReason(event),
          readyState,
        });
        return;
      }

      if (!input.detachSocket(socket)) {
        return;
      }

      const reason = readErrorEventReason(event);
      input.logger.warn("connector.websocket.error", {
        url: input.connectorUrl,
        reason,
      });
      input.closeSocketQuietly(socket, 1011, "websocket error");

      input.hooks.onDisconnected?.({
        code: 1006,
        reason,
        wasClean: false,
      });

      if (input.isStarted()) {
        input.scheduleReconnect();
      }
    },
    onUnexpectedResponse: (event: unknown) => {
      void input.onUnexpectedResponse(socket, event);
    },
  };
}
