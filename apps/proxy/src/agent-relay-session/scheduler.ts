import { RELAY_HEARTBEAT_INTERVAL_MS } from "./constants.js";
import { findNextQueueWakeMs } from "./queue-state.js";
import type { DurableObjectStorageLike, RelayQueueState } from "./types.js";

export async function scheduleNextRelayAlarm(input: {
  storage: DurableObjectStorageLike;
  queueState: RelayQueueState;
  nowMs: number;
  hasActiveSockets: boolean;
}): Promise<void> {
  const candidates: number[] = [];

  const queueWakeAtMs = findNextQueueWakeMs(input.queueState, input.nowMs);
  if (queueWakeAtMs !== undefined) {
    candidates.push(queueWakeAtMs);
  }

  if (input.hasActiveSockets) {
    candidates.push(input.nowMs + RELAY_HEARTBEAT_INTERVAL_MS);
  }

  if (candidates.length === 0) {
    await input.storage.deleteAlarm?.();
    return;
  }

  await input.storage.setAlarm(Math.min(...candidates));
}
