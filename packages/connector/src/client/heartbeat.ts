import type { HeartbeatAckFrame } from "../frames.js";

export type HeartbeatAckTimeoutEvent = {
  pendingCount: number;
  oldestPendingAgeMs: number;
  timeoutMs: number;
};

export type HeartbeatMetricsSnapshot = {
  avgRttMs?: number;
  maxRttMs?: number;
  lastRttMs?: number;
  pendingAckCount: number;
  sampleCount: number;
};

export class ConnectorHeartbeatManager {
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatAckTimeoutMs: number;
  private readonly now: () => number;
  private readonly onAckTimeout: (event: HeartbeatAckTimeoutEvent) => void;

  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatAckTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingHeartbeatAcks = new Map<string, number>();

  private heartbeatRttSampleCount = 0;
  private heartbeatRttTotalMs = 0;
  private heartbeatRttMaxMs = 0;
  private heartbeatRttLastMs: number | undefined;

  constructor(input: {
    heartbeatIntervalMs: number;
    heartbeatAckTimeoutMs: number;
    now: () => number;
    onAckTimeout: (event: HeartbeatAckTimeoutEvent) => void;
  }) {
    this.heartbeatIntervalMs = input.heartbeatIntervalMs;
    this.heartbeatAckTimeoutMs = input.heartbeatAckTimeoutMs;
    this.now = input.now;
    this.onAckTimeout = input.onAckTimeout;
  }

  start(emitHeartbeat: () => string | undefined): void {
    this.stop();

    if (this.heartbeatIntervalMs <= 0) {
      return;
    }

    this.heartbeatInterval = setInterval(() => {
      const ackId = emitHeartbeat();
      if (ackId !== undefined) {
        this.trackHeartbeatAck(ackId);
      }
    }, this.heartbeatIntervalMs);
  }

  stop(): void {
    if (this.heartbeatInterval !== undefined) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.heartbeatAckTimeout !== undefined) {
      clearTimeout(this.heartbeatAckTimeout);
      this.heartbeatAckTimeout = undefined;
    }

    this.pendingHeartbeatAcks.clear();
  }

  handleHeartbeatAck(frame: HeartbeatAckFrame): void {
    const sentAtMs = this.pendingHeartbeatAcks.get(frame.ackId);
    if (sentAtMs === undefined) {
      return;
    }

    this.pendingHeartbeatAcks.delete(frame.ackId);
    const rttMs = Math.max(0, this.now() - sentAtMs);
    this.heartbeatRttSampleCount += 1;
    this.heartbeatRttTotalMs += rttMs;
    this.heartbeatRttMaxMs = Math.max(this.heartbeatRttMaxMs, rttMs);
    this.heartbeatRttLastMs = rttMs;

    this.scheduleHeartbeatAckTimeoutCheck();
  }

  getMetricsSnapshot(): HeartbeatMetricsSnapshot {
    return {
      pendingAckCount: this.pendingHeartbeatAcks.size,
      sampleCount: this.heartbeatRttSampleCount,
      lastRttMs: this.heartbeatRttLastMs,
      maxRttMs:
        this.heartbeatRttSampleCount > 0 ? this.heartbeatRttMaxMs : undefined,
      avgRttMs:
        this.heartbeatRttSampleCount > 0
          ? Math.floor(this.heartbeatRttTotalMs / this.heartbeatRttSampleCount)
          : undefined,
    };
  }

  private trackHeartbeatAck(ackId: string): void {
    if (this.heartbeatAckTimeoutMs <= 0) {
      return;
    }

    this.pendingHeartbeatAcks.set(ackId, this.now());
    this.scheduleHeartbeatAckTimeoutCheck();
  }

  private scheduleHeartbeatAckTimeoutCheck(): void {
    if (this.heartbeatAckTimeout !== undefined) {
      clearTimeout(this.heartbeatAckTimeout);
      this.heartbeatAckTimeout = undefined;
    }

    if (
      this.pendingHeartbeatAcks.size === 0 ||
      this.heartbeatAckTimeoutMs <= 0
    ) {
      return;
    }

    const oldestSentAt = this.getOldestPendingSentAtMs();
    const elapsedMs = this.now() - oldestSentAt;
    const delayMs = Math.max(0, this.heartbeatAckTimeoutMs - elapsedMs);

    this.heartbeatAckTimeout = setTimeout(() => {
      this.heartbeatAckTimeout = undefined;
      this.handleHeartbeatAckTimeout();
    }, delayMs);
  }

  private handleHeartbeatAckTimeout(): void {
    const pendingCount = this.pendingHeartbeatAcks.size;
    if (pendingCount === 0) {
      return;
    }

    const oldestSentAt = this.getOldestPendingSentAtMs();
    const oldestPendingAgeMs = this.now() - oldestSentAt;
    if (oldestPendingAgeMs < this.heartbeatAckTimeoutMs) {
      this.scheduleHeartbeatAckTimeoutCheck();
      return;
    }

    this.onAckTimeout({
      pendingCount,
      oldestPendingAgeMs,
      timeoutMs: this.heartbeatAckTimeoutMs,
    });
  }

  private getOldestPendingSentAtMs(): number {
    let oldestSentAt = Number.POSITIVE_INFINITY;
    for (const sentAt of this.pendingHeartbeatAcks.values()) {
      oldestSentAt = Math.min(oldestSentAt, sentAt);
    }

    return oldestSentAt;
  }
}
