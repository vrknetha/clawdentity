import type { Logger } from "@clawdentity/sdk";
import { nowIso } from "@clawdentity/sdk";
import { sanitizeErrorReason } from "./errors.js";
import type {
  DeliveryWebhookGatewayProbeStatus,
  DeliveryWebhookProbePolicy,
} from "./types.js";

export function createDeliveryWebhookGatewayProbeController(input: {
  fetchImpl: typeof fetch;
  isRuntimeStopping: () => boolean;
  logger: Logger;
  deliveryWebhookGatewayProbeStatus: DeliveryWebhookGatewayProbeStatus;
  deliveryWebhookProbePolicy: DeliveryWebhookProbePolicy;
  deliveryWebhookProbeUrl: string;
  runtimeShutdownSignal: AbortSignal;
}): {
  probeDeliveryWebhookGateway: () => Promise<void>;
} {
  let deliveryWebhookProbeInFlight = false;

  const probeDeliveryWebhookGateway = async (): Promise<void> => {
    if (input.isRuntimeStopping() || deliveryWebhookProbeInFlight) {
      return;
    }

    deliveryWebhookProbeInFlight = true;

    const checkedAt = nowIso();
    try {
      const timeoutSignal = AbortSignal.timeout(
        input.deliveryWebhookProbePolicy.timeoutMs,
      );
      const signal = AbortSignal.any([
        input.runtimeShutdownSignal,
        timeoutSignal,
      ]);
      await input.fetchImpl(input.deliveryWebhookProbeUrl, {
        method: "GET",
        signal,
      });
      input.deliveryWebhookGatewayProbeStatus.reachable = true;
      input.deliveryWebhookGatewayProbeStatus.lastCheckedAt = checkedAt;
      input.deliveryWebhookGatewayProbeStatus.lastSuccessAt = checkedAt;
      input.deliveryWebhookGatewayProbeStatus.lastFailureReason = undefined;
    } catch (error) {
      if (input.runtimeShutdownSignal.aborted) {
        return;
      }

      input.deliveryWebhookGatewayProbeStatus.reachable = false;
      input.deliveryWebhookGatewayProbeStatus.lastCheckedAt = checkedAt;
      input.deliveryWebhookGatewayProbeStatus.lastFailureReason =
        sanitizeErrorReason(error);
    } finally {
      deliveryWebhookProbeInFlight = false;
    }
  };

  return {
    probeDeliveryWebhookGateway,
  };
}
