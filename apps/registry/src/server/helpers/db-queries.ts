import { AppError } from "@clawdentity/sdk";
import { and, eq } from "drizzle-orm";
import type { createDb } from "../../db/client.js";
import {
  agent_auth_sessions,
  agent_registration_challenges,
  agents,
  invites,
  starter_passes,
} from "../../db/schema.js";
import {
  inviteRedeemAlreadyUsedError,
  inviteRedeemCodeInvalidError,
  inviteRedeemExpiredError,
} from "../../invite-lifecycle.js";
import {
  starterPassAlreadyUsedError,
  starterPassCodeInvalidError,
  starterPassExpiredError,
} from "../../starter-pass-lifecycle.js";
import type {
  InviteRow,
  OwnedAgent,
  OwnedAgentAuthSession,
  OwnedAgentRegistrationChallenge,
  StarterPassRow,
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
      agent_id: invites.agent_id,
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
      agent_id: invites.agent_id,
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

export async function findStarterPassByCode(input: {
  db: ReturnType<typeof createDb>;
  code: string;
}): Promise<StarterPassRow | undefined> {
  const rows = await input.db
    .select({
      id: starter_passes.id,
      code: starter_passes.code,
      provider: starter_passes.provider,
      provider_subject: starter_passes.provider_subject,
      provider_login: starter_passes.provider_login,
      display_name: starter_passes.display_name,
      redeemed_by: starter_passes.redeemed_by,
      issued_at: starter_passes.issued_at,
      redeemed_at: starter_passes.redeemed_at,
      expires_at: starter_passes.expires_at,
      status: starter_passes.status,
    })
    .from(starter_passes)
    .where(eq(starter_passes.code, input.code))
    .limit(1);

  return rows[0];
}

export async function findStarterPassByProviderSubject(input: {
  db: ReturnType<typeof createDb>;
  provider: "github";
  providerSubject: string;
}): Promise<StarterPassRow | undefined> {
  const rows = await input.db
    .select({
      id: starter_passes.id,
      code: starter_passes.code,
      provider: starter_passes.provider,
      provider_subject: starter_passes.provider_subject,
      provider_login: starter_passes.provider_login,
      display_name: starter_passes.display_name,
      redeemed_by: starter_passes.redeemed_by,
      issued_at: starter_passes.issued_at,
      redeemed_at: starter_passes.redeemed_at,
      expires_at: starter_passes.expires_at,
      status: starter_passes.status,
    })
    .from(starter_passes)
    .where(
      and(
        eq(starter_passes.provider, input.provider),
        eq(starter_passes.provider_subject, input.providerSubject),
      ),
    )
    .limit(1);

  return rows[0];
}

export async function countAgentsByOwner(input: {
  db: ReturnType<typeof createDb>;
  ownerId: string;
}): Promise<number> {
  const rows = await input.db
    .select({
      id: agents.id,
    })
    .from(agents)
    .where(eq(agents.owner_id, input.ownerId));

  return rows.length;
}

export async function resolveStarterPassRedeemStateError(input: {
  db: ReturnType<typeof createDb>;
  starterPassId: string;
  nowMillis: number;
}) {
  const rows = await input.db
    .select({
      id: starter_passes.id,
      redeemed_by: starter_passes.redeemed_by,
      expires_at: starter_passes.expires_at,
      status: starter_passes.status,
    })
    .from(starter_passes)
    .where(eq(starter_passes.id, input.starterPassId))
    .limit(1);
  const starterPass = rows[0];

  if (!starterPass) {
    return starterPassCodeInvalidError();
  }

  if (starterPass.redeemed_by !== null || starterPass.status === "redeemed") {
    return starterPassAlreadyUsedError();
  }

  if (starterPass.status === "expired") {
    return starterPassExpiredError();
  }

  const expiresAtMillis = Date.parse(starterPass.expires_at);
  if (!Number.isFinite(expiresAtMillis) || expiresAtMillis <= input.nowMillis) {
    return starterPassExpiredError();
  }

  return starterPassCodeInvalidError();
}

export function isUnsupportedLocalTransactionError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Failed query: begin")
  );
}

function invalidMutationResultShapeError(input: {
  operation: string;
  result: unknown;
}): AppError {
  const keys =
    input.result && typeof input.result === "object"
      ? Object.keys(input.result as Record<string, unknown>)
      : [];

  return new AppError({
    code: "DB_MUTATION_RESULT_INVALID",
    message: `Database mutation result must include meta.changes (${input.operation})`,
    status: 500,
    expose: false,
    details: {
      operation: input.operation,
      resultType: input.result === null ? "null" : typeof input.result,
      keys,
    },
  });
}

export function getMutationRowCount(input: {
  result: unknown;
  operation: string;
}): number {
  const { result, operation } = input;
  if (!result || typeof result !== "object") {
    throw invalidMutationResultShapeError({ operation, result });
  }

  const metaChanges = (result as { meta?: { changes?: unknown } }).meta
    ?.changes;
  if (typeof metaChanges === "number") {
    return metaChanges;
  }

  throw invalidMutationResultShapeError({ operation, result });
}
