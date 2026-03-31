import { and, eq } from "drizzle-orm";
import type { createDb } from "../../db/client.js";
import { agents, group_members, groups } from "../../db/schema.js";
import {
  groupJoinForbiddenError,
  groupManageForbiddenError,
  groupNotFoundError,
} from "../routes/group-route-errors.js";
import type { GroupRouteAuthActor } from "./group-route-auth.js";

export async function resolveReadableGroupForHuman(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  humanId: string;
}): Promise<{ id: string; name: string }> {
  const groupRows = await input.db
    .select({
      id: groups.id,
      name: groups.name,
      createdBy: groups.created_by,
    })
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw groupNotFoundError();
  }

  if (group.createdBy === input.humanId) {
    return { id: group.id, name: group.name };
  }

  const membershipRows = await input.db
    .select({
      agentId: group_members.agent_id,
    })
    .from(group_members)
    .innerJoin(agents, eq(group_members.agent_id, agents.id))
    .where(
      and(
        eq(group_members.group_id, input.groupId),
        eq(agents.owner_id, input.humanId),
        eq(agents.status, "active"),
      ),
    )
    .limit(1);

  if (!membershipRows[0]) {
    throw groupJoinForbiddenError();
  }

  return { id: group.id, name: group.name };
}

export async function resolveManageableGroupForHuman(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  humanId: string;
}): Promise<{ id: string; name: string }> {
  const groupRows = await input.db
    .select({
      id: groups.id,
      name: groups.name,
      createdBy: groups.created_by,
    })
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw groupNotFoundError();
  }

  if (group.createdBy === input.humanId) {
    return { id: group.id, name: group.name };
  }

  const adminMembershipRows = await input.db
    .select({
      agentId: agents.id,
    })
    .from(group_members)
    .innerJoin(agents, eq(group_members.agent_id, agents.id))
    .where(
      and(
        eq(group_members.group_id, input.groupId),
        eq(group_members.role, "admin"),
        eq(agents.owner_id, input.humanId),
        eq(agents.status, "active"),
      ),
    )
    .limit(1);

  if (!adminMembershipRows[0]) {
    throw groupManageForbiddenError();
  }

  return { id: group.id, name: group.name };
}

export async function resolveReadableGroupForAgent(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  agentId: string;
  humanId: string;
}): Promise<{ id: string; name: string }> {
  const groupRows = await input.db
    .select({
      id: groups.id,
      name: groups.name,
      createdBy: groups.created_by,
    })
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw groupNotFoundError();
  }

  if (group.createdBy === input.humanId) {
    return { id: group.id, name: group.name };
  }

  const membershipRows = await input.db
    .select({
      agentId: group_members.agent_id,
    })
    .from(group_members)
    .where(
      and(
        eq(group_members.group_id, input.groupId),
        eq(group_members.agent_id, input.agentId),
      ),
    )
    .limit(1);

  if (!membershipRows[0]) {
    throw groupJoinForbiddenError();
  }

  return { id: group.id, name: group.name };
}

export async function resolveManageableGroupForAgent(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  agentId: string;
  humanId: string;
}): Promise<{ id: string; name: string }> {
  const groupRows = await input.db
    .select({
      id: groups.id,
      name: groups.name,
      createdBy: groups.created_by,
    })
    .from(groups)
    .where(eq(groups.id, input.groupId))
    .limit(1);
  const group = groupRows[0];
  if (!group) {
    throw groupNotFoundError();
  }

  if (group.createdBy === input.humanId) {
    return { id: group.id, name: group.name };
  }

  const adminMembershipRows = await input.db
    .select({
      agentId: group_members.agent_id,
    })
    .from(group_members)
    .where(
      and(
        eq(group_members.group_id, input.groupId),
        eq(group_members.agent_id, input.agentId),
        eq(group_members.role, "admin"),
      ),
    )
    .limit(1);

  if (!adminMembershipRows[0]) {
    throw groupManageForbiddenError();
  }

  return { id: group.id, name: group.name };
}

export async function resolveReadableGroupForActor(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  actor: GroupRouteAuthActor;
}): Promise<{ id: string; name: string }> {
  if (input.actor.kind === "human") {
    return resolveReadableGroupForHuman({
      db: input.db,
      groupId: input.groupId,
      humanId: input.actor.humanId,
    });
  }

  return resolveReadableGroupForAgent({
    db: input.db,
    groupId: input.groupId,
    humanId: input.actor.humanId,
    agentId: input.actor.agentId,
  });
}

export async function resolveManageableGroupForActor(input: {
  db: ReturnType<typeof createDb>;
  groupId: string;
  actor: GroupRouteAuthActor;
}): Promise<{ id: string; name: string }> {
  if (input.actor.kind === "human") {
    return resolveManageableGroupForHuman({
      db: input.db,
      groupId: input.groupId,
      humanId: input.actor.humanId,
    });
  }

  return resolveManageableGroupForAgent({
    db: input.db,
    groupId: input.groupId,
    humanId: input.actor.humanId,
    agentId: input.actor.agentId,
  });
}
