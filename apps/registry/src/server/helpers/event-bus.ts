import { generateUlid } from "@clawdentity/protocol";
import {
  AppError,
  createEventEnvelope,
  createInMemoryEventBus,
  createQueueEventBus,
  type EventBus,
  nowIso,
  nowUtcMs,
  type RegistryConfig,
} from "@clawdentity/sdk";
import type { createDb } from "../../db/client.js";
import { agent_auth_events } from "../../db/schema.js";
import {
  AGENT_AUTH_EVENT_NAME_BY_TYPE,
  type Bindings,
  logger,
  REGISTRY_SERVICE_EVENT_VERSION,
} from "../constants.js";

export function resolveEventBusBackend(
  config: RegistryConfig,
): NonNullable<RegistryConfig["EVENT_BUS_BACKEND"]> {
  if (config.EVENT_BUS_BACKEND === "memory") {
    return "memory";
  }

  if (config.EVENT_BUS_BACKEND === "queue") {
    return "queue";
  }

  return config.ENVIRONMENT === "development" ||
    config.ENVIRONMENT === "production"
    ? "queue"
    : "memory";
}

export function resolveRegistryEventBus(input: {
  config: RegistryConfig;
  bindings: Bindings;
  explicitBus?: EventBus;
}): EventBus {
  if (input.explicitBus !== undefined) {
    return input.explicitBus;
  }

  const backend = resolveEventBusBackend(input.config);
  if (backend === "memory") {
    return createInMemoryEventBus();
  }

  const queue = input.bindings.EVENT_BUS_QUEUE;
  if (queue === undefined) {
    throw new AppError({
      code: "CONFIG_VALIDATION_FAILED",
      message: "Registry configuration is invalid",
      status: 500,
      expose: true,
      details: {
        fieldErrors: {
          EVENT_BUS_QUEUE: [
            "EVENT_BUS_QUEUE is required when EVENT_BUS_BACKEND is queue",
          ],
        },
        formErrors: [],
      },
    });
  }

  return createQueueEventBus(queue);
}

export async function insertAgentAuthEvent(input: {
  db: ReturnType<typeof createDb>;
  agentId: string;
  sessionId: string;
  eventType: "issued" | "refreshed" | "revoked" | "refresh_rejected";
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  eventBus?: EventBus;
  initiatedByAccountId?: string | null;
}): Promise<void> {
  const createdAt = input.createdAt ?? nowIso();
  await input.db.insert(agent_auth_events).values({
    id: generateUlid(nowUtcMs()),
    agent_id: input.agentId,
    session_id: input.sessionId,
    event_type: input.eventType,
    reason: input.reason ?? null,
    metadata_json:
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    created_at: createdAt,
  });

  if (input.eventBus === undefined) {
    return;
  }

  const eventData: Record<string, unknown> = {
    agentId: input.agentId,
    sessionId: input.sessionId,
  };
  if (input.reason !== undefined) {
    eventData.reason = input.reason;
  }
  if (input.metadata !== undefined) {
    eventData.metadata = input.metadata;
  }

  try {
    await input.eventBus.publish(
      createEventEnvelope({
        type: AGENT_AUTH_EVENT_NAME_BY_TYPE[input.eventType],
        version: REGISTRY_SERVICE_EVENT_VERSION,
        initiatedByAccountId: input.initiatedByAccountId ?? null,
        timestampUtc: createdAt,
        data: eventData,
      }),
    );
  } catch (error) {
    logger.warn("registry.event_bus.publish_failed", {
      eventType: input.eventType,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}
