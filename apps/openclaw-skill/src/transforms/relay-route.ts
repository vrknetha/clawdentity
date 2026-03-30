import { parseGroupId as parseProtocolGroupId } from "@clawdentity/protocol";

type RelayRoute =
  | {
      mode: "direct";
      peerAlias: string;
    }
  | {
      mode: "group";
      groupId: string;
    };

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveRelayRoute(
  payload: Record<string, unknown>,
): RelayRoute | undefined {
  const peerAlias = parseOptionalString(payload.peer);
  const explicitGroupId = parseOptionalString(payload.groupId);
  const fallbackGroupId = parseOptionalString(payload.group);
  const rawGroupId = explicitGroupId ?? fallbackGroupId;

  if (peerAlias && rawGroupId) {
    throw new Error("Provide either peer or groupId/group, not both");
  }

  if (rawGroupId) {
    let groupId: string;
    try {
      groupId = parseProtocolGroupId(rawGroupId);
    } catch {
      throw new Error("groupId must be a valid group ID");
    }

    return {
      mode: "group",
      groupId,
    };
  }

  if (peerAlias) {
    return {
      mode: "direct",
      peerAlias,
    };
  }

  return undefined;
}
