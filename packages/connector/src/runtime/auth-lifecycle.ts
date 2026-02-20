import type { AgentAuthBundle, Logger } from "@clawdentity/sdk";
import { nowUtcMs, refreshAgentAuthWithClawProof } from "@clawdentity/sdk";
import {
  readRegistryAuthFromDisk,
  writeRegistryAuthAtomic,
} from "./auth-storage.js";
import { shouldRefreshAccessToken } from "./parse.js";

export type RuntimeAuthController = {
  getCurrentAuth: () => AgentAuthBundle;
  persistCurrentAuth: (nextAuth: AgentAuthBundle) => Promise<void>;
  refreshCurrentAuth: () => Promise<void>;
  refreshCurrentAuthIfNeeded: () => Promise<void>;
  syncAuthFromDisk: () => Promise<void>;
};

export function createRuntimeAuthController(input: {
  agentName: string;
  ait: string;
  configDir: string;
  fetchImpl: typeof fetch;
  initialAuth: AgentAuthBundle;
  logger: Logger;
  registryUrl: string;
  secretKey: Uint8Array;
}): RuntimeAuthController {
  let currentAuth = input.initialAuth;

  const syncAuthFromDisk = async (): Promise<void> => {
    const diskAuth = await readRegistryAuthFromDisk({
      configDir: input.configDir,
      agentName: input.agentName,
      logger: input.logger,
    });
    if (!diskAuth) {
      return;
    }

    if (
      diskAuth.accessToken === currentAuth.accessToken &&
      diskAuth.accessExpiresAt === currentAuth.accessExpiresAt &&
      diskAuth.refreshToken === currentAuth.refreshToken &&
      diskAuth.refreshExpiresAt === currentAuth.refreshExpiresAt
    ) {
      return;
    }

    currentAuth = diskAuth;
    input.logger.info("connector.runtime.registry_auth_synced", {
      agentName: input.agentName,
    });
  };

  const persistCurrentAuth = async (
    nextAuth: AgentAuthBundle,
  ): Promise<void> => {
    currentAuth = nextAuth;
    await writeRegistryAuthAtomic({
      configDir: input.configDir,
      agentName: input.agentName,
      auth: nextAuth,
    });
  };

  const refreshCurrentAuth = async (): Promise<void> => {
    const refreshed = await refreshAgentAuthWithClawProof({
      registryUrl: input.registryUrl,
      ait: input.ait,
      secretKey: input.secretKey,
      refreshToken: currentAuth.refreshToken,
      fetchImpl: input.fetchImpl,
    });
    await persistCurrentAuth(refreshed);
  };

  const refreshCurrentAuthIfNeeded = async (): Promise<void> => {
    await syncAuthFromDisk();
    if (!shouldRefreshAccessToken(currentAuth, nowUtcMs())) {
      return;
    }

    await refreshCurrentAuth();
  };

  return {
    getCurrentAuth: () => currentAuth,
    persistCurrentAuth,
    refreshCurrentAuth,
    refreshCurrentAuthIfNeeded,
    syncAuthFromDisk,
  };
}
