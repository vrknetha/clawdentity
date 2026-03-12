import type {
  FakeAgentRow,
  FakeCrlSelectRow,
  FakeRevocationRow,
} from "../types.js";

export function getCrlSelectColumnValue(
  row: FakeCrlSelectRow,
  column: string,
): unknown {
  if (column === "id") {
    return row.id;
  }
  if (column === "jti") {
    return row.jti;
  }
  if (column === "reason") {
    return row.reason;
  }
  if (column === "revoked_at") {
    return row.revoked_at;
  }
  if (column === "revokedat") {
    return row.revoked_at;
  }
  if (column === "agent_did") {
    return row.agent_did;
  }
  if (column === "agentdid" || column === "did") {
    return row.did;
  }
  return undefined;
}

export function resolveCrlSelectRows(options: {
  agentRows: FakeAgentRow[];
  revocationRows: FakeRevocationRow[];
}): FakeCrlSelectRow[] {
  return options.revocationRows
    .map((row) => {
      const agent = options.agentRows.find(
        (agentRow) => agentRow.id === row.agentId,
      );
      if (!agent) {
        return null;
      }

      return {
        id: row.id,
        jti: row.jti,
        reason: row.reason,
        revoked_at: row.revokedAt,
        agent_did: agent.did,
        did: agent.did,
      };
    })
    .filter((row): row is FakeCrlSelectRow => row !== null)
    .sort((left, right) => {
      const timestampCompare = right.revoked_at.localeCompare(left.revoked_at);
      if (timestampCompare !== 0) {
        return timestampCompare;
      }
      return right.id.localeCompare(left.id);
    });
}
