import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Logger } from "@clawdentity/sdk";
import type { DeliveryWebhookSenderProfile } from "../deliveryWebhook-headers.js";
import { DELIVERY_WEBHOOK_RELAY_RUNTIME_FILE_NAME } from "./constants.js";
import { sanitizeErrorReason } from "./errors.js";
import { isRecord, parseOptionalProxyOrigin } from "./parse.js";

export type RelayTransformPeerEntry = {
  agentDid: string;
  proxyOrigin?: string;
  senderProfile?: DeliveryWebhookSenderProfile;
};

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readRelayTransformPeersPath(input: {
  configDir: string;
  logger: Logger;
}): Promise<string | undefined> {
  const relayRuntimeConfigPath = join(
    input.configDir,
    DELIVERY_WEBHOOK_RELAY_RUNTIME_FILE_NAME,
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
      return undefined;
    }

    input.logger.warn("connector.runtime.relay_runtime_config_read_failed", {
      relayRuntimeConfigPath,
      reason: sanitizeErrorReason(error),
    });
    return undefined;
  }

  let relayRuntimeParsed: unknown;
  try {
    relayRuntimeParsed = JSON.parse(relayRuntimeRaw);
  } catch (error) {
    input.logger.warn("connector.runtime.relay_runtime_config_invalid_json", {
      relayRuntimeConfigPath,
      reason: sanitizeErrorReason(error),
    });
    return undefined;
  }

  if (!isRecord(relayRuntimeParsed)) {
    return undefined;
  }

  const relayTransformPeersPathRaw = parseOptionalNonEmptyString(
    relayRuntimeParsed.relayTransformPeersPath,
  );
  if (!relayTransformPeersPathRaw) {
    return undefined;
  }

  return isAbsolute(relayTransformPeersPathRaw)
    ? relayTransformPeersPathRaw
    : join(input.configDir, relayTransformPeersPathRaw);
}

export async function loadRelayTransformPeerEntries(input: {
  configDir: string;
  logger: Logger;
}): Promise<RelayTransformPeerEntry[]> {
  const relayTransformPeersPath = await readRelayTransformPeersPath(input);
  if (!relayTransformPeersPath) {
    return [];
  }

  let relayTransformPeersRaw: string;
  try {
    relayTransformPeersRaw = await readFile(relayTransformPeersPath, "utf8");
  } catch (error) {
    input.logger.warn("connector.runtime.relay_peers_snapshot_read_failed", {
      relayTransformPeersPath,
      reason: sanitizeErrorReason(error),
    });
    return [];
  }

  let relayTransformPeersParsed: unknown;
  try {
    relayTransformPeersParsed = JSON.parse(relayTransformPeersRaw);
  } catch (error) {
    input.logger.warn("connector.runtime.relay_peers_snapshot_invalid_json", {
      relayTransformPeersPath,
      reason: sanitizeErrorReason(error),
    });
    return [];
  }

  if (!isRecord(relayTransformPeersParsed)) {
    return [];
  }

  const peersValue = relayTransformPeersParsed.peers;
  if (!isRecord(peersValue)) {
    return [];
  }

  const entries: RelayTransformPeerEntry[] = [];
  for (const peerValue of Object.values(peersValue)) {
    if (!isRecord(peerValue)) {
      continue;
    }

    const agentDid = parseOptionalNonEmptyString(peerValue.did);
    if (!agentDid) {
      continue;
    }

    const agentName = parseOptionalNonEmptyString(peerValue.agentName);
    const displayName = parseOptionalNonEmptyString(peerValue.displayName);

    entries.push({
      agentDid,
      proxyOrigin: parseOptionalProxyOrigin(peerValue.proxyUrl),
      senderProfile:
        agentName !== undefined || displayName !== undefined
          ? { agentName, displayName }
          : undefined,
    });
  }

  return entries;
}

export async function loadSenderProfilesByDid(input: {
  configDir: string;
  logger: Logger;
}): Promise<Map<string, DeliveryWebhookSenderProfile>> {
  const byDid = new Map<string, DeliveryWebhookSenderProfile>();
  const entries = await loadRelayTransformPeerEntries(input);

  for (const entry of entries) {
    if (entry.senderProfile !== undefined) {
      byDid.set(entry.agentDid, entry.senderProfile);
    }
  }

  return byDid;
}
