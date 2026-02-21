import type { PendingDelivery } from "./types.js";

export function rejectPendingDeliveries(
  pendingDeliveries: Map<string, PendingDelivery>,
  error: Error,
): void {
  for (const [deliveryId, pending] of pendingDeliveries) {
    clearTimeout(pending.timeoutHandle);
    pending.reject(error);
    pendingDeliveries.delete(deliveryId);
  }
}
