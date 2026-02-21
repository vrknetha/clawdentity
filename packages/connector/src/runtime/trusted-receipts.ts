import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Logger } from "@clawdentity/sdk";
import { OPENCLAW_RELAY_RUNTIME_FILE_NAME } from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";
import { isRecord, parseOptionalProxyOrigin } from "./parse.js";
import type { TrustedReceiptTargets } from "./types.js";

export async function loadTrustedReceiptTargets(input: {
  configDir: string;
  logger: Logger;
}): Promise<TrustedReceiptTargets> {
  const trustedReceiptTargets: TrustedReceiptTargets = {
    origins: new Set<string>(),
    byAgentDid: new Map<string, string>(),
  };

  const relayRuntimeConfigPath = join(
    input.configDir,
    OPENCLAW_RELAY_RUNTIME_FILE_NAME,
  );
  let relayRuntimeRaw: string;
  try {
    relayRuntimeRaw = await readFile(relayRuntimeConfigPath, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return trustedReceiptTargets;
    }

    input.logger.warn("connector.delivery_receipt.runtime_config_read_failed", {
      relayRuntimeConfigPath,
      reason: sanitizeErrorReason(error),
    });
    return trustedReceiptTargets;
  }

  let relayRuntimeParsed: unknown;
  try {
    relayRuntimeParsed = JSON.parse(relayRuntimeRaw);
  } catch (error) {
    input.logger.warn(
      "connector.delivery_receipt.runtime_config_invalid_json",
      {
        relayRuntimeConfigPath,
        reason: sanitizeErrorReason(error),
      },
    );
    return trustedReceiptTargets;
  }

  if (!isRecord(relayRuntimeParsed)) {
    return trustedReceiptTargets;
  }

  const relayTransformPeersPathRaw =
    typeof relayRuntimeParsed.relayTransformPeersPath === "string" &&
    relayRuntimeParsed.relayTransformPeersPath.trim().length > 0
      ? relayRuntimeParsed.relayTransformPeersPath.trim()
      : undefined;
  if (!relayTransformPeersPathRaw) {
    return trustedReceiptTargets;
  }

  const relayTransformPeersPath = isAbsolute(relayTransformPeersPathRaw)
    ? relayTransformPeersPathRaw
    : join(input.configDir, relayTransformPeersPathRaw);

  let relayTransformPeersRaw: string;
  try {
    relayTransformPeersRaw = await readFile(relayTransformPeersPath, "utf8");
  } catch (error) {
    input.logger.warn("connector.delivery_receipt.peers_snapshot_read_failed", {
      relayTransformPeersPath,
      reason: sanitizeErrorReason(error),
    });
    return trustedReceiptTargets;
  }

  let relayTransformPeersParsed: unknown;
  try {
    relayTransformPeersParsed = JSON.parse(relayTransformPeersRaw);
  } catch (error) {
    input.logger.warn(
      "connector.delivery_receipt.peers_snapshot_invalid_json",
      {
        relayTransformPeersPath,
        reason: sanitizeErrorReason(error),
      },
    );
    return trustedReceiptTargets;
  }

  if (!isRecord(relayTransformPeersParsed)) {
    return trustedReceiptTargets;
  }

  const peersValue = relayTransformPeersParsed.peers;
  if (!isRecord(peersValue)) {
    return trustedReceiptTargets;
  }

  for (const peerValue of Object.values(peersValue)) {
    if (!isRecord(peerValue)) {
      continue;
    }

    const agentDid =
      typeof peerValue.did === "string" && peerValue.did.trim().length > 0
        ? peerValue.did.trim()
        : undefined;
    const origin = parseOptionalProxyOrigin(peerValue.proxyUrl);
    if (!agentDid || !origin) {
      continue;
    }

    trustedReceiptTargets.origins.add(origin);
    trustedReceiptTargets.byAgentDid.set(agentDid, origin);
  }

  return trustedReceiptTargets;
}
