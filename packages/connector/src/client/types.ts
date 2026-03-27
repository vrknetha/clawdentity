import type {
  ConnectorFrame,
  DeliverFrame,
  EnqueueFrame,
  ReceiptFrame,
} from "../frames.js";

export type ConnectorWebSocketEventType =
  | "open"
  | "message"
  | "close"
  | "error"
  | "unexpected-response";

export type ConnectorWebSocketListener = (event: unknown) => void;

export type ConnectorWebSocket = {
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (
    type: ConnectorWebSocketEventType,
    listener: ConnectorWebSocketListener,
  ) => void;
};

export type ConnectorClientHooks = {
  onConnected?: () => void;
  onDisconnected?: (event: {
    code: number;
    reason: string;
    wasClean: boolean;
  }) => void;
  onAuthUpgradeRejected?: (event: {
    status: number;
    immediateRetry: boolean;
  }) => void | Promise<void>;
  onFrame?: (frame: ConnectorFrame) => void;
  onDeliverSucceeded?: (frame: DeliverFrame) => void;
  onDeliverFailed?: (frame: DeliverFrame, error: unknown) => void;
  onReceipt?: (frame: ReceiptFrame) => void | Promise<void>;
};

export type ConnectorOutboundQueuePersistence = {
  load: () => Promise<EnqueueFrame[]>;
  save: (frames: EnqueueFrame[]) => Promise<void>;
};

export type ConnectorClientMetricsSnapshot = {
  connection: {
    connectAttempts: number;
    connected: boolean;
    reconnectCount: number;
    uptimeMs: number;
    lastConnectedAt?: string;
  };
  heartbeat: {
    avgRttMs?: number;
    maxRttMs?: number;
    lastRttMs?: number;
    pendingAckCount: number;
    sampleCount: number;
  };
  inboundDelivery: {
    avgAckLatencyMs?: number;
    maxAckLatencyMs?: number;
    lastAckLatencyMs?: number;
    sampleCount: number;
  };
  outboundQueue: {
    currentDepth: number;
    loadedFromPersistence: boolean;
    maxDepth: number;
    persistenceEnabled: boolean;
  };
};

export type ConnectorClientOptions = {
  connectorUrl: string;
  connectionHeaders?: Record<string, string>;
  connectionHeadersProvider?:
    | (() => Record<string, string> | Promise<Record<string, string>>)
    | undefined;
  openclawBaseUrl: string;
  openclawHookToken?: string;
  openclawHookPath?: string;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffFactor?: number;
  reconnectJitterRatio?: number;
  openclawDeliverTimeoutMs?: number;
  openclawDeliverMaxAttempts?: number;
  openclawDeliverRetryInitialDelayMs?: number;
  openclawDeliverRetryMaxDelayMs?: number;
  openclawDeliverRetryBackoffFactor?: number;
  openclawDeliverRetryBudgetMs?: number;
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => ConnectorWebSocket;
  fetchImpl?: typeof fetch;
  logger?: import("@clawdentity/sdk").Logger;
  hooks?: ConnectorClientHooks;
  outboundQueuePersistence?: ConnectorOutboundQueuePersistence;
  inboundDeliverHandler?:
    | ((frame: DeliverFrame) => Promise<{ accepted: boolean; reason?: string }>)
    | undefined;
  now?: () => number;
  random?: () => number;
  ulidFactory?: (time?: number) => string;
};

export type ConnectorOutboundEnqueueInput = {
  toAgentDid: string;
  payload: unknown;
  conversationId?: string;
  replyTo?: string;
};
