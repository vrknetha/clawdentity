import type { Logger } from "@clawdentity/sdk";
import { readOpenclawHookTokenFromRelayRuntimeConfig } from "./openclaw.js";

export type OpenclawHookTokenSyncReason = "auth_rejected" | "batch";

export type OpenclawHookTokenController = {
  getCurrentOpenclawHookToken: () => string | undefined;
  syncOpenclawHookToken: (reason: OpenclawHookTokenSyncReason) => Promise<void>;
};

export function createOpenclawHookTokenController(input: {
  configDir: string;
  explicitOpenclawHookToken: string | undefined;
  logger: Logger;
}): OpenclawHookTokenController {
  const hasExplicitOpenclawHookToken =
    input.explicitOpenclawHookToken !== undefined;
  let currentOpenclawHookToken = input.explicitOpenclawHookToken;

  const syncOpenclawHookToken = async (
    reason: OpenclawHookTokenSyncReason,
  ): Promise<void> => {
    if (hasExplicitOpenclawHookToken) {
      return;
    }

    const diskToken = await readOpenclawHookTokenFromRelayRuntimeConfig({
      configDir: input.configDir,
      logger: input.logger,
    });
    if (diskToken === currentOpenclawHookToken) {
      return;
    }

    currentOpenclawHookToken = diskToken;
    input.logger.info("connector.runtime.openclaw_hook_token_synced", {
      reason,
      source: diskToken !== undefined ? "openclaw-relay.json" : "unset",
      hasToken: currentOpenclawHookToken !== undefined,
    });
  };

  return {
    getCurrentOpenclawHookToken: () => currentOpenclawHookToken,
    syncOpenclawHookToken,
  };
}
