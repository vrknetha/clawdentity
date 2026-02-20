import type { ConnectorClientMetricsSnapshot } from "./types.js";

type HeartbeatMetricsSnapshot = ConnectorClientMetricsSnapshot["heartbeat"];
type OutboundQueueMetricsSnapshot =
  ConnectorClientMetricsSnapshot["outboundQueue"];

type ConnectorMetricsSnapshotInput = {
  connected: boolean;
  heartbeat: HeartbeatMetricsSnapshot;
  outboundQueue: OutboundQueueMetricsSnapshot;
};

export class ConnectorClientMetricsTracker {
  private connectAttempts = 0;
  private reconnectCount = 0;
  private connectedSinceMs: number | undefined;
  private accumulatedConnectedMs = 0;
  private lastConnectedAtIso: string | undefined;

  private inboundAckLatencySampleCount = 0;
  private inboundAckLatencyTotalMs = 0;
  private inboundAckLatencyMaxMs = 0;
  private inboundAckLatencyLastMs: number | undefined;

  constructor(private readonly now: () => number) {}

  onConnectAttempt(): void {
    this.connectAttempts += 1;
  }

  onReconnectScheduled(): void {
    this.reconnectCount += 1;
  }

  onSocketConnected(connectedAtIso: string): void {
    this.connectedSinceMs = this.now();
    this.lastConnectedAtIso = connectedAtIso;
  }

  onSocketDetached(): void {
    if (this.connectedSinceMs === undefined) {
      return;
    }

    this.accumulatedConnectedMs += Math.max(
      0,
      this.now() - this.connectedSinceMs,
    );
    this.connectedSinceMs = undefined;
  }

  recordInboundDeliveryAckLatency(durationMs: number): void {
    const latencyMs = Math.max(0, Math.floor(durationMs));
    this.inboundAckLatencySampleCount += 1;
    this.inboundAckLatencyTotalMs += latencyMs;
    this.inboundAckLatencyMaxMs = Math.max(
      this.inboundAckLatencyMaxMs,
      latencyMs,
    );
    this.inboundAckLatencyLastMs = latencyMs;
  }

  getSnapshot(
    input: ConnectorMetricsSnapshotInput,
  ): ConnectorClientMetricsSnapshot {
    const nowMs = this.now();
    const uptimeMs =
      this.accumulatedConnectedMs +
      (this.connectedSinceMs === undefined ? 0 : nowMs - this.connectedSinceMs);

    return {
      connection: {
        connectAttempts: this.connectAttempts,
        connected: input.connected,
        reconnectCount: this.reconnectCount,
        uptimeMs: Math.max(0, uptimeMs),
        lastConnectedAt: this.lastConnectedAtIso,
      },
      heartbeat: input.heartbeat,
      inboundDelivery: {
        sampleCount: this.inboundAckLatencySampleCount,
        lastAckLatencyMs: this.inboundAckLatencyLastMs,
        maxAckLatencyMs:
          this.inboundAckLatencySampleCount > 0
            ? this.inboundAckLatencyMaxMs
            : undefined,
        avgAckLatencyMs:
          this.inboundAckLatencySampleCount > 0
            ? Math.floor(
                this.inboundAckLatencyTotalMs /
                  this.inboundAckLatencySampleCount,
              )
            : undefined,
      },
      outboundQueue: input.outboundQueue,
    };
  }
}
