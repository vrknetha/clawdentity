import { toIso } from "@clawdentity/sdk";
import { RELAY_QUEUE_STORAGE_KEY } from "./constants.js";
import { computeRetryDelayMs } from "./policy.js";
import {
  deleteQueuedReceipt,
  isQueuedDelivery,
  normalizeReceipts,
  pruneExpiredQueueState,
  upsertReceipt,
} from "./queue-state.js";
import { scheduleNextRelayAlarm } from "./scheduler.js";
import type {
  DurableObjectStateLike,
  RelayDeliveryInput,
  RelayDeliveryPolicy,
  RelayQueueState,
} from "./types.js";

type RelayQueueManagerInput = {
  state: DurableObjectStateLike;
  deliveryPolicy: RelayDeliveryPolicy;
  getActiveSockets: (nowMs: number) => WebSocket[];
  getPendingDeliveriesCount: () => number;
  sendDeliverFrame: (
    socket: WebSocket,
    input: RelayDeliveryInput,
  ) => Promise<boolean>;
};

export class RelayQueueManager {
  private readonly state: DurableObjectStateLike;
  private readonly deliveryPolicy: RelayDeliveryPolicy;
  private readonly getActiveSockets: (nowMs: number) => WebSocket[];
  private readonly getPendingDeliveriesCount: () => number;
  private readonly sendDeliverFrame: (
    socket: WebSocket,
    input: RelayDeliveryInput,
  ) => Promise<boolean>;
  private inMemoryQueueState: RelayQueueState = {
    deliveries: [],
    receipts: {},
  };

  constructor(input: RelayQueueManagerInput) {
    this.state = input.state;
    this.deliveryPolicy = input.deliveryPolicy;
    this.getActiveSockets = input.getActiveSockets;
    this.getPendingDeliveriesCount = input.getPendingDeliveriesCount;
    this.sendDeliverFrame = input.sendDeliverFrame;
  }

  async loadQueueState(nowMs: number): Promise<RelayQueueState> {
    const fromStorage = this.state.storage.get
      ? await this.state.storage.get(RELAY_QUEUE_STORAGE_KEY)
      : this.inMemoryQueueState;
    const rawState =
      typeof fromStorage === "object" && fromStorage !== null
        ? (fromStorage as Partial<RelayQueueState>)
        : undefined;

    const queueState: RelayQueueState = {
      deliveries: Array.isArray(rawState?.deliveries)
        ? rawState.deliveries.filter((entry) => isQueuedDelivery(entry))
        : [],
      receipts: normalizeReceipts(rawState?.receipts),
    };

    const pruned = pruneExpiredQueueState(queueState, nowMs);
    if (pruned) {
      await this.saveQueueState(queueState);
    }

    return queueState;
  }

  async saveQueueState(queueState: RelayQueueState): Promise<void> {
    const serialized: RelayQueueState = {
      deliveries: [...queueState.deliveries],
      receipts: { ...queueState.receipts },
    };

    if (this.state.storage.put) {
      await this.state.storage.put(RELAY_QUEUE_STORAGE_KEY, serialized);
      return;
    }

    this.inMemoryQueueState = serialized;
  }

  async processQueueDeliveries(
    queueState: RelayQueueState,
    nowMs: number,
  ): Promise<boolean> {
    if (queueState.deliveries.length === 0) {
      return false;
    }

    const sockets = this.getActiveSockets(nowMs);
    if (sockets.length === 0) {
      let mutated = false;
      for (const delivery of queueState.deliveries) {
        if (delivery.nextAttemptAtMs <= nowMs) {
          delivery.nextAttemptAtMs =
            nowMs +
            computeRetryDelayMs(this.deliveryPolicy, delivery.attemptCount);
          mutated = true;
        }
      }

      return mutated;
    }

    queueState.deliveries.sort((left, right) => {
      if (left.nextAttemptAtMs !== right.nextAttemptAtMs) {
        return left.nextAttemptAtMs - right.nextAttemptAtMs;
      }

      return left.createdAtMs - right.createdAtMs;
    });

    let mutated = false;
    const socket = sockets[0];

    for (let index = 0; index < queueState.deliveries.length; ) {
      if (
        this.getPendingDeliveriesCount() >=
        this.deliveryPolicy.maxInFlightDeliveries
      ) {
        break;
      }

      const delivery = queueState.deliveries[index];

      if (delivery.expiresAtMs <= nowMs) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      if (delivery.attemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      if (delivery.nextAttemptAtMs > nowMs) {
        index += 1;
        continue;
      }

      let accepted = false;
      let deliveryError = false;
      try {
        accepted = await this.sendDeliverFrame(socket, {
          requestId: delivery.requestId,
          senderAgentDid: delivery.senderAgentDid,
          recipientAgentDid: delivery.recipientAgentDid,
          conversationId: delivery.conversationId,
          replyTo: delivery.replyTo,
          payload: delivery.payload,
        });
      } catch {
        deliveryError = true;
      }

      if (accepted) {
        queueState.deliveries.splice(index, 1);
        upsertReceipt(queueState, {
          requestId: delivery.requestId,
          deliveryId: delivery.deliveryId,
          state: "delivered",
          expiresAtMs: nowMs + this.deliveryPolicy.queueTtlMs,
          senderAgentDid: delivery.senderAgentDid,
          recipientAgentDid: delivery.recipientAgentDid,
          statusUpdatedAt: toIso(nowMs),
        });
        mutated = true;
        continue;
      }

      const nextAttemptCount = delivery.attemptCount + 1;
      if (nextAttemptCount >= this.deliveryPolicy.retryMaxAttempts) {
        queueState.deliveries.splice(index, 1);
        deleteQueuedReceipt(
          queueState,
          delivery.requestId,
          delivery.deliveryId,
        );
        mutated = true;
        continue;
      }

      delivery.attemptCount = nextAttemptCount;
      delivery.nextAttemptAtMs =
        nowMs + computeRetryDelayMs(this.deliveryPolicy, delivery.attemptCount);
      mutated = true;
      index += 1;

      if (deliveryError) {
        for (
          let remaining = index;
          remaining < queueState.deliveries.length;
          remaining += 1
        ) {
          const pendingDelivery = queueState.deliveries[remaining];
          if (pendingDelivery.nextAttemptAtMs <= nowMs) {
            pendingDelivery.nextAttemptAtMs =
              nowMs +
              computeRetryDelayMs(
                this.deliveryPolicy,
                pendingDelivery.attemptCount,
              );
          }
        }
        break;
      }
    }

    return mutated;
  }

  async drainQueueOnReconnect(nowMs: number): Promise<void> {
    const queueState = await this.loadQueueState(nowMs);
    let queueMutated = false;

    for (const delivery of queueState.deliveries) {
      if (delivery.nextAttemptAtMs > nowMs) {
        delivery.nextAttemptAtMs = nowMs;
        queueMutated = true;
      }
    }

    if (await this.processQueueDeliveries(queueState, nowMs)) {
      queueMutated = true;
    }

    if (queueMutated) {
      await this.saveQueueState(queueState);
    }

    await this.scheduleNextAlarm(queueState, nowMs);
  }

  async scheduleFromStorage(nowMs: number): Promise<void> {
    const queueState = await this.loadQueueState(nowMs);
    await this.scheduleNextAlarm(queueState, nowMs);
  }

  async scheduleNextAlarm(
    queueState: RelayQueueState,
    nowMs: number,
  ): Promise<void> {
    await scheduleNextRelayAlarm({
      storage: this.state.storage,
      queueState,
      nowMs,
      hasActiveSockets: this.getActiveSockets(nowMs).length > 0,
    });
  }
}
