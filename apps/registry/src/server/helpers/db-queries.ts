import { and, eq } from "drizzle-orm";
import type { createDb } from "../../db/client.js";
import {
  agent_auth_sessions,
  agent_registration_challenges,
  agents,
  invites,
} from "../../db/schema.js";
import {
  inviteRedeemAlreadyUsedError,
  inviteRedeemCodeInvalidError,
  inviteRedeemExpiredError,
} from "../../invite-lifecycle.js";
import type {
  InviteRow,
  OwnedAgent,
  OwnedAgentAuthSession,
  OwnedAgentRegistrationChallenge,
} from "../constants.js";

export async function findOwnedAgent(input: {
  db: ReturnType<typeof createDb>;
  ownerId: string;
  agentId: string;
}): Promise<OwnedAgent | undefined> {
  const rows = await input.db
    .select({
      id: agents.id,
      did: agents.did,
      name: agents.name,
      framework: agents.framework,
      public_key: agents.public_key,
      status: agents.status,
      expires_at: agents.expires_at,
      current_jti: agents.current_jti,
    })
    .from(agents)
    .where(
      and(eq(agents.owner_id, input.ownerId), eq(agents.id, input.agentId)),
    )
    .limit(1);

  return rows[0];
}

export async function findAgentAuthSessionByAgentId(input: {
  db: ReturnType<typeof createDb>;
  agentId: string;
}): Promise<OwnedAgentAuthSession | undefined> {
  const rows = await input.db
    .select({
      id: agent_auth_sessions.id,
      agent_id: agent_auth_sessions.agent_id,
      refresh_key_hash: agent_auth_sessions.refresh_key_hash,
      refresh_key_prefix: agent_auth_sessions.refresh_key_prefix,
      refresh_issued_at: agent_auth_sessions.refresh_issued_at,
      refresh_expires_at: agent_auth_sessions.refresh_expires_at,
      refresh_last_used_at: agent_auth_sessions.refresh_last_used_at,
      access_key_hash: agent_auth_sessions.access_key_hash,
      access_key_prefix: agent_auth_sessions.access_key_prefix,
      access_issued_at: agent_auth_sessions.access_issued_at,
      access_expires_at: agent_auth_sessions.access_expires_at,
      access_last_used_at: agent_auth_sessions.access_last_used_at,
      status: agent_auth_sessions.status,
      revoked_at: agent_auth_sessions.revoked_at,
      created_at: agent_auth_sessions.created_at,
      updated_at: agent_auth_sessions.updated_at,
    })
    .from(agent_auth_sessions)
    .where(eq(agent_auth_sessions.agent_id, input.agentId))
    .limit(1);

  return rows[0];
}

export async function findOwnedAgentByDid(input: {
  db: ReturnType<typeof createDb>;
  did: string;
}): Promise<OwnedAgent | undefined> {
  const rows = await input.db
    .select({
      id: agents.id,
      did: agents.did,
      name: agents.name,
      framework: agents.framework,
      public_key: agents.public_key,
      status: agents.status,
      expires_at: agents.expires_at,
      current_jti: agents.current_jti,
    })
    .from(agents)
    .where(eq(agents.did, input.did))
    .limit(1);

  return rows[0];
}

export async function findOwnedAgentRegistrationChallenge(input: {
  db: ReturnType<typeof createDb>;
  ownerId: string;
  challengeId: string;
}): Promise<OwnedAgentRegistrationChallenge | undefined> {
  const rows = await input.db
    .select({
      id: agent_registration_challenges.id,
      owner_id: agent_registration_challenges.owner_id,
      public_key: agent_registration_challenges.public_key,
      nonce: agent_registration_challenges.nonce,
      status: agent_registration_challenges.status,
      expires_at: agent_registration_challenges.expires_at,
      used_at: agent_registration_challenges.used_at,
    })
    .from(agent_registration_challenges)
    .where(
      and(
        eq(agent_registration_challenges.owner_id, input.ownerId),
        eq(agent_registration_challenges.id, input.challengeId),
      ),
    )
    .limit(1);

  return rows[0];
}

export async function findInviteByCode(input: {
  db: ReturnType<typeof createDb>;
  code: string;
}): Promise<InviteRow | undefined> {
  const rows = await input.db
    .select({
      id: invites.id,
      code: invites.code,
      created_by: invites.created_by,
      redeemed_by: invites.redeemed_by,
      expires_at: invites.expires_at,
      created_at: invites.created_at,
    })
    .from(invites)
    .where(eq(invites.code, input.code))
    .limit(1);

  return rows[0];
}

export async function findInviteById(input: {
  db: ReturnType<typeof createDb>;
  id: string;
}): Promise<InviteRow | undefined> {
  const rows = await input.db
    .select({
      id: invites.id,
      code: invites.code,
      created_by: invites.created_by,
      redeemed_by: invites.redeemed_by,
      expires_at: invites.expires_at,
      created_at: invites.created_at,
    })
    .from(invites)
    .where(eq(invites.id, input.id))
    .limit(1);

  return rows[0];
}

export function isInviteExpired(input: {
  expiresAt: string | null;
  nowMillis: number;
}) {
  if (typeof input.expiresAt !== "string") {
    return false;
  }

  const expiresAtMillis = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAtMillis)) {
    return true;
  }

  return expiresAtMillis <= input.nowMillis;
}

export async function resolveInviteRedeemStateError(input: {
  db: ReturnType<typeof createDb>;
  inviteId: string;
  nowMillis: number;
}) {
  const latestInvite = await findInviteById({
    db: input.db,
    id: input.inviteId,
  });

  if (!latestInvite) {
    return inviteRedeemCodeInvalidError();
  }

  if (latestInvite.redeemed_by !== null) {
    return inviteRedeemAlreadyUsedError();
  }

  if (
    isInviteExpired({
      expiresAt: latestInvite.expires_at,
      nowMillis: input.nowMillis,
    })
  ) {
    return inviteRedeemExpiredError();
  }

  return inviteRedeemCodeInvalidError();
}

export function isUnsupportedLocalTransactionError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Failed query: begin")
  );
}

export function getMutationRowCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const directChanges = (result as { changes?: unknown }).changes;
  if (typeof directChanges === "number") {
    return directChanges;
  }

  const rowsAffected = (result as { rowsAffected?: unknown }).rowsAffected;
  if (typeof rowsAffected === "number") {
    return rowsAffected;
  }

  const metaChanges = (result as { meta?: { changes?: unknown } }).meta
    ?.changes;
  if (typeof metaChanges === "number") {
    return metaChanges;
  }

  return undefined;
}
