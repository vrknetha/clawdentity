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

function parseRoutingString(input: {
  payload: Record<string, unknown>;
  field: string;
  label: string;
}): string | undefined {
  const value = input.payload[input.field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${input.label} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${input.label} must be a non-empty string`);
  }

  return trimmed;
}

export function resolveRelayRoute(
  payload: Record<string, unknown>,
): RelayRoute | undefined {
  const peerAlias = parseRoutingString({
    payload,
    field: "peer",
    label: "peer",
  });
  const explicitGroupId = parseRoutingString({
    payload,
    field: "groupId",
    label: "groupId",
  });
  const fallbackGroupId = parseRoutingString({
    payload,
    field: "group",
    label: "group",
  });
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
