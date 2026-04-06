import type { RegistryConfig } from "@clawdentity/sdk";
import { AppError } from "@clawdentity/sdk";
import { eq } from "drizzle-orm";
import { verifyAgentClawRequest } from "../../auth/agent-claw-auth.js";
import { resolvePatHuman } from "../../auth/api-key-auth.js";
import type { createDb } from "../../db/client.js";
import { agents } from "../../db/schema.js";

export type ActiveGroupRouteAgent = {
  id: string;
  did: string;
  name: string;
  framework: string | null;
  ownerId: string;
  status: "active";
  currentJti: string | null;
};

export type GroupRouteAuthActor =
  | {
      kind: "human";
      humanId: string;
    }
  | {
      kind: "agent";
      humanId: string;
      agentId: string;
      agentDid: string;
    };

export async function readRequestBodyBytes(
  request: Request,
): Promise<Uint8Array> {
  return new Uint8Array(await request.clone().arrayBuffer());
}

export function parseJsonBodyFromBytes<T = unknown>(input: {
  bodyBytes: Uint8Array;
  invalidError: () => Error;
}): T {
  try {
    const rawBody = new TextDecoder().decode(input.bodyBytes);
    return (rawBody.trim().length === 0 ? {} : JSON.parse(rawBody)) as T;
  } catch {
    throw input.invalidError();
  }
}

function isBearerAuth(
  authorization: string | undefined,
): authorization is string {
  return (
    typeof authorization === "string" && authorization.startsWith("Bearer ")
  );
}

export async function assertAgentIsActiveCurrent(input: {
  db: ReturnType<typeof createDb>;
  agentDid: string;
  aitJti: string;
}): Promise<ActiveGroupRouteAgent> {
  const rows = await input.db
    .select({
      id: agents.id,
      did: agents.did,
      name: agents.name,
      framework: agents.framework,
      ownerId: agents.owner_id,
      status: agents.status,
      currentJti: agents.current_jti,
    })
    .from(agents)
    .where(eq(agents.did, input.agentDid))
    .limit(1);

  const row = rows[0];
  if (!row || row.status !== "active" || row.currentJti !== input.aitJti) {
    throw new AppError({
      code: "AGENT_AUTH_VALIDATE_UNAUTHORIZED",
      message: "Agent access token is invalid",
      status: 401,
      expose: true,
    });
  }

  return {
    ...row,
    status: "active",
  };
}

export async function resolveGroupRouteAuthActor(input: {
  db: ReturnType<typeof createDb>;
  config: RegistryConfig;
  request: Request;
  bodyBytes: Uint8Array;
}): Promise<GroupRouteAuthActor> {
  const authorization = input.request.headers.get("authorization") ?? undefined;

  if (isBearerAuth(authorization)) {
    const human = await resolvePatHuman({
      db: input.db,
      authorizationHeader: authorization,
      touchLastUsed: true,
    });
    return {
      kind: "human",
      humanId: human.id,
    };
  }

  const claims = await verifyAgentClawRequest({
    config: input.config,
    request: input.request,
    bodyBytes: input.bodyBytes,
  });
  const activeAgent = await assertAgentIsActiveCurrent({
    db: input.db,
    agentDid: claims.sub,
    aitJti: claims.jti,
  });
  return {
    kind: "agent",
    humanId: activeAgent.ownerId,
    agentId: activeAgent.id,
    agentDid: activeAgent.did,
  };
}
