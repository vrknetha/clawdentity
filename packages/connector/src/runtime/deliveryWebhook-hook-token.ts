import type { Logger } from "@clawdentity/sdk";
import { readDeliveryWebhookHookTokenFromRelayRuntimeConfig } from "./deliveryWebhook.js";

export type DeliveryWebhookHookTokenSyncReason = "auth_rejected" | "batch";

export type DeliveryWebhookHookTokenController = {
  getCurrentDeliveryWebhookHookToken: () => string | undefined;
  syncDeliveryWebhookHookToken: (
    reason: DeliveryWebhookHookTokenSyncReason,
  ) => Promise<void>;
};

export function createDeliveryWebhookHookTokenController(input: {
  configDir: string;
  explicitDeliveryWebhookHookToken: string | undefined;
  logger: Logger;
}): DeliveryWebhookHookTokenController {
  const hasExplicitDeliveryWebhookHookToken =
    input.explicitDeliveryWebhookHookToken !== undefined;
  let currentDeliveryWebhookHookToken = input.explicitDeliveryWebhookHookToken;

  const syncDeliveryWebhookHookToken = async (
    reason: DeliveryWebhookHookTokenSyncReason,
  ): Promise<void> => {
    if (hasExplicitDeliveryWebhookHookToken) {
      return;
    }

    const diskToken = await readDeliveryWebhookHookTokenFromRelayRuntimeConfig({
      configDir: input.configDir,
      logger: input.logger,
    });
    if (diskToken === currentDeliveryWebhookHookToken) {
      return;
    }

    currentDeliveryWebhookHookToken = diskToken;
    input.logger.info("connector.runtime.deliveryWebhook_hook_token_synced", {
      reason,
      source: diskToken !== undefined ? "deliveryWebhook-relay.json" : "unset",
      hasToken: currentDeliveryWebhookHookToken !== undefined,
    });
  };

  return {
    getCurrentDeliveryWebhookHookToken: () => currentDeliveryWebhookHookToken,
    syncDeliveryWebhookHookToken,
  };
}
