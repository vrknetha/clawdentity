import { AppError } from "@clawdentity/sdk";
import type { ProxyTrustStore } from "./proxy-trust-store.js";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export async function assertKnownTrustedAgent(input: {
  trustStore: ProxyTrustStore;
  agentDid: string;
}): Promise<void> {
  let isKnownAgent = false;
  try {
    isKnownAgent = await input.trustStore.isAgentKnown(input.agentDid);
  } catch (error) {
    throw new AppError({
      code: "PROXY_AUTH_DEPENDENCY_UNAVAILABLE",
      message: "Proxy trust state is unavailable",
      status: 503,
      details: {
        reason: toErrorMessage(error),
      },
      expose: true,
    });
  }

  if (!isKnownAgent) {
    throw new AppError({
      code: "PROXY_AUTH_FORBIDDEN",
      message: "Verified caller is not trusted",
      status: 403,
      details: {
        agentDid: input.agentDid,
      },
      expose: true,
    });
  }
}

export async function assertTrustedPair(input: {
  trustStore: ProxyTrustStore;
  initiatorAgentDid: string;
  responderAgentDid: string;
}): Promise<void> {
  let isPairAllowed = false;
  try {
    isPairAllowed = await input.trustStore.isPairAllowed({
      initiatorAgentDid: input.initiatorAgentDid,
      responderAgentDid: input.responderAgentDid,
    });
  } catch (error) {
    throw new AppError({
      code: "PROXY_PAIR_STATE_UNAVAILABLE",
      message: "Pairing state is unavailable",
      status: 503,
      details: {
        reason: toErrorMessage(error),
      },
      expose: true,
    });
  }

  if (!isPairAllowed) {
    throw new AppError({
      code: "PROXY_AUTH_FORBIDDEN",
      message: "Verified caller is not trusted for recipient",
      status: 403,
      expose: true,
    });
  }
}
