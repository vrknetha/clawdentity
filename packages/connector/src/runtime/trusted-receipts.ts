import type { Logger } from "@clawdentity/sdk";
import { loadRelayTransformPeerEntries } from "./relay-transform-peers.js";
import type { TrustedReceiptTargets } from "./types.js";

export async function loadTrustedReceiptTargets(input: {
  configDir: string;
  logger: Logger;
}): Promise<TrustedReceiptTargets> {
  const trustedReceiptTargets: TrustedReceiptTargets = {
    origins: new Set<string>(),
    byAgentDid: new Map<string, string>(),
  };

  const peers = await loadRelayTransformPeerEntries({
    configDir: input.configDir,
    logger: input.logger,
  });

  for (const peer of peers) {
    if (!peer.proxyOrigin) {
      continue;
    }

    trustedReceiptTargets.origins.add(peer.proxyOrigin);
    trustedReceiptTargets.byAgentDid.set(peer.agentDid, peer.proxyOrigin);
  }

  return trustedReceiptTargets;
}
