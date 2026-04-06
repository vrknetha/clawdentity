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
  if (payload.group !== undefined) {
    throw new Error("group is not supported; use groupId");
  }

  const peerAlias = parseRoutingString({
    payload,
    field: "peer",
    label: "peer",
  });
  const groupId = parseRoutingString({
    payload,
    field: "groupId",
    label: "groupId",
  });

  if (peerAlias && groupId) {
    throw new Error("Provide either peer or groupId, not both");
  }

  if (groupId) {
    let normalizedGroupId: string;
    try {
      normalizedGroupId = parseProtocolGroupId(groupId);
    } catch {
      throw new Error("groupId must be a valid group ID");
    }

    return {
      mode: "group",
      groupId: normalizedGroupId,
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
