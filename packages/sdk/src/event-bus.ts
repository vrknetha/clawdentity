import { nowIso, nowUtcMs } from "./datetime.js";

const DEFAULT_EVENT_VERSION = "v1";

export type EventEnvelope<TData extends Record<string, unknown>> = {
  id: string;
  type: string;
  version: string;
  timestampUtc: string;
  initiatedByAccountId: string | null;
  data: TData;
};

export type EventEnvelopeInput<TData extends Record<string, unknown>> = {
  id?: string;
  type: string;
  version?: string;
  timestampUtc?: string;
  initiatedByAccountId?: string | null;
  data: TData;
};

export type EventBus = {
  publish<TData extends Record<string, unknown>>(
    event: EventEnvelope<TData>,
  ): Promise<void>;
};

export type EventHandler = (
  event: EventEnvelope<Record<string, unknown>>,
) => Promise<void> | void;

export type InMemoryEventBus = EventBus & {
  subscribe(handler: EventHandler): () => void;
  readonly publishedEvents: readonly EventEnvelope<Record<string, unknown>>[];
};

export type QueuePublisher = {
  send(message: string): Promise<void>;
};

function createEventId(): string {
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `${nowUtcMs()}-${random}`;
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (normalized.length > 0) {
    return normalized;
  }

  throw new Error(`${fieldName} must be a non-empty string`);
}

function normalizeOptionalString(
  value: string | undefined,
  fallback: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function createEventEnvelope<TData extends Record<string, unknown>>(
  input: EventEnvelopeInput<TData>,
): EventEnvelope<TData> {
  return {
    id: normalizeOptionalString(input.id, createEventId()),
    type: normalizeRequiredString(input.type, "type"),
    version: normalizeOptionalString(input.version, DEFAULT_EVENT_VERSION),
    timestampUtc: normalizeOptionalString(input.timestampUtc, nowIso()),
    initiatedByAccountId: input.initiatedByAccountId ?? null,
    data: input.data,
  };
}

export function createInMemoryEventBus(): InMemoryEventBus {
  const handlers = new Set<EventHandler>();
  const publishedEvents: EventEnvelope<Record<string, unknown>>[] = [];

  return {
    async publish<TData extends Record<string, unknown>>(
      event: EventEnvelope<TData>,
    ): Promise<void> {
      const normalized = event as EventEnvelope<Record<string, unknown>>;
      publishedEvents.push(normalized);
      for (const handler of handlers) {
        await handler(normalized);
      }
    },
    subscribe(handler: EventHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    get publishedEvents() {
      return publishedEvents;
    },
  };
}

export function createQueueEventBus(queue: QueuePublisher): EventBus {
  return {
    async publish<TData extends Record<string, unknown>>(
      event: EventEnvelope<TData>,
    ): Promise<void> {
      await queue.send(JSON.stringify(event));
    },
  };
}
