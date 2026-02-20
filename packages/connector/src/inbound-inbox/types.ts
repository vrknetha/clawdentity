export type ConnectorInboundInboxItem = {
  attemptCount: number;
  conversationId?: string;
  fromAgentDid: string;
  id: string;
  lastAttemptAt?: string;
  lastError?: string;
  nextAttemptAt: string;
  payload: unknown;
  payloadBytes: number;
  receivedAt: string;
  replyTo?: string;
  requestId: string;
  toAgentDid: string;
};

export type ConnectorInboundDeadLetterItem = ConnectorInboundInboxItem & {
  deadLetterReason: string;
  deadLetteredAt: string;
};

export type InboundInboxIndexFile = {
  deadLetterByRequestId: Record<string, ConnectorInboundDeadLetterItem>;
  deadLetterBytes: number;
  pendingBytes: number;
  pendingByRequestId: Record<string, ConnectorInboundInboxItem>;
  updatedAt: string;
  version: number;
};

export type InboundInboxEvent = {
  details?: Record<string, unknown>;
  requestId?: string;
  type:
    | "inbound_persisted"
    | "inbound_duplicate"
    | "replay_succeeded"
    | "replay_failed"
    | "dead_letter_moved"
    | "dead_letter_replayed"
    | "dead_letter_purged"
    | "inbox_pruned";
};

export type ConnectorInboundInboxPendingSnapshot = {
  nextAttemptAt?: string;
  oldestPendingAt?: string;
  pendingBytes: number;
  pendingCount: number;
};

export type ConnectorInboundInboxDeadLetterSnapshot = {
  deadLetterBytes: number;
  deadLetterCount: number;
  oldestDeadLetterAt?: string;
};

export type ConnectorInboundInboxSnapshot = {
  deadLetter: ConnectorInboundInboxDeadLetterSnapshot;
  pending: ConnectorInboundInboxPendingSnapshot;
};

export type ConnectorInboundInboxEnqueueResult = {
  accepted: boolean;
  duplicate: boolean;
  pendingCount: number;
  reason?: string;
};

export type ConnectorInboundInboxMarkFailureResult = {
  movedToDeadLetter: boolean;
};

export type ConnectorInboundInboxOptions = {
  agentName: string;
  configDir: string;
  eventsMaxBytes: number;
  eventsMaxFiles: number;
  maxPendingBytes: number;
  maxPendingMessages: number;
};
