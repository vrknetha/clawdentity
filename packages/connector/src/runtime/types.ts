import type { Logger } from "@clawdentity/sdk";
import type { ConnectorInboundInboxSnapshot } from "../inbound-inbox.js";

export type ConnectorRuntimeCredentials = {
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
  deliveryWebhookBaseUrl?: string;
  deliveryWebhookPath?: string;
  deliveryWebhookToken?: string;
  outboundBaseUrl?: string;
  outboundPath?: string;
  proxyWebsocketUrl?: string;
};

export type ConnectorRuntimeHandle = {
  outboundUrl: string;
  stop: () => Promise<void>;
  waitUntilStopped: () => Promise<void>;
  websocketUrl: string;
};

export type OutboundRelayRequest = {
  conversationId?: string;
  payload: unknown;
  peer: string;
  peerDid: string;
  peerProxyUrl: string;
  replyTo?: string;
};

export type OutboundDeliveryReceiptStatus =
  | "delivered_to_webhook"
  | "dead_lettered";

export type TrustedReceiptTargets = {
  byAgentDid: Map<string, string>;
  origins: Set<string>;
};

export type InboundReplayPolicy = {
  batchSize: number;
  deadLetterNonRetryableMaxAttempts: number;
  eventsMaxRows: number;
  inboxMaxBytes: number;
  inboxMaxMessages: number;
  replayIntervalMs: number;
  retryBackoffFactor: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  runtimeReplayMaxAttempts: number;
  runtimeReplayRetryBackoffFactor: number;
  runtimeReplayRetryInitialDelayMs: number;
  runtimeReplayRetryMaxDelayMs: number;
};

export type DeliveryWebhookProbePolicy = {
  intervalMs: number;
  timeoutMs: number;
};

export type InboundReplayStatus = {
  lastReplayAt?: string;
  lastReplayError?: string;
  lastAttemptAt?: string;
  lastAttemptStatus?: "ok" | "failed";
  replayerActive: boolean;
};

export type InboundReplayView = {
  lastReplayAt?: string;
  lastReplayError?: string;
  snapshot: ConnectorInboundInboxSnapshot;
  replayerActive: boolean;
  deliveryWebhookGateway: {
    lastCheckedAt?: string;
    lastFailureReason?: string;
    lastSuccessAt?: string;
    reachable: boolean;
    url: string;
  };
  deliveryWebhookHook: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url: string;
  };
};

export type DeliveryWebhookGatewayProbeStatus = {
  lastCheckedAt?: string;
  lastFailureReason?: string;
  lastSuccessAt?: string;
  reachable: boolean;
};
