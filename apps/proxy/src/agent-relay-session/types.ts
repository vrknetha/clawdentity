export type DurableObjectStorageLike = {
  deleteAlarm?: () => Promise<void> | void;
  get?: (key: string) => Promise<unknown> | unknown;
  put?: (key: string, value: unknown) => Promise<void> | void;
  setAlarm: (scheduledTime: number | Date) => Promise<void> | void;
};

export type DurableObjectStateLike = {
  acceptWebSocket: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets: () => WebSocket[];
  storage: DurableObjectStorageLike;
};

export type RelayDeliveryInput = {
  conversationId?: string;
  payload: unknown;
  recipientAgentDid: string;
  replyTo?: string;
  requestId: string;
  senderAgentDid: string;
};

export type RelayDeliveryState =
  | "delivered"
  | "queued"
  | "processed_by_openclaw"
  | "dead_lettered";

export type RelayDeliveryResult = {
  connectedSockets: number;
  delivered: boolean;
  deliveryId: string;
  queueDepth: number;
  queued: boolean;
  state: RelayDeliveryState;
};

export type RelayReceiptRecordInput = {
  reason?: string;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
  status: "processed_by_openclaw" | "dead_lettered";
};

export type RelayReceiptLookupInput = {
  requestId: string;
  senderAgentDid: string;
};

export type RelayReceiptLookupResult = {
  found: boolean;
  receipt?: RelayDeliveryReceipt;
};

export type AgentRelaySessionStub = {
  deliverToConnector?: (
    input: RelayDeliveryInput,
  ) => Promise<RelayDeliveryResult>;
  getDeliveryReceipt?: (
    input: RelayReceiptLookupInput,
  ) => Promise<RelayReceiptLookupResult>;
  recordDeliveryReceipt?: (input: RelayReceiptRecordInput) => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
};

export type AgentRelaySessionNamespace = {
  get: (id: DurableObjectId) => AgentRelaySessionStub;
  idFromName: (name: string) => DurableObjectId;
};

export type PendingDelivery = {
  reject: (error: unknown) => void;
  resolve: (accepted: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

export type QueuedRelayDelivery = {
  attemptCount: number;
  createdAtMs: number;
  deliveryId: string;
  expiresAtMs: number;
  nextAttemptAtMs: number;
  payload: unknown;
  recipientAgentDid: string;
  replyTo?: string;
  requestId: string;
  senderAgentDid: string;
  conversationId?: string;
};

export type RelayDeliveryReceipt = {
  deliveryId: string;
  expiresAtMs: number;
  recipientAgentDid: string;
  reason?: string;
  requestId: string;
  senderAgentDid: string;
  statusUpdatedAt: string;
  state: RelayDeliveryState;
};

export type RelayQueueState = {
  deliveries: QueuedRelayDelivery[];
  receipts: Record<string, RelayDeliveryReceipt>;
};

export type RelayDeliveryPolicy = {
  maxFrameBytes: number;
  maxInFlightDeliveries: number;
  queueMaxMessagesPerAgent: number;
  queueTtlMs: number;
  retryInitialMs: number;
  retryJitterRatio: number;
  retryMaxAttempts: number;
  retryMaxMs: number;
};
