import { AppError, nowIso } from "@clawdentity/sdk";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db/client.js";
import { api_keys, humans } from "../db/schema.js";
import {
  constantTimeEqual,
  deriveApiKeyLookupPrefix,
  hashApiKeyToken,
  parseBearerPat,
} from "./api-key-token.js";

type ApiKeyQueryRow = {
  api_key_id: string;
  key_hash: string;
  api_key_status: "active" | "revoked";
  api_key_name: string;
  human_id: string;
  human_did: string;
  human_display_name: string;
  human_role: "admin" | "user";
  human_status: "active" | "suspended";
  human_onboarding_source: string | null;
  human_agent_limit: number | null;
};

export type AuthenticatedHuman = {
  id: string;
  did: string;
  displayName: string;
  role: "admin" | "user";
  onboardingSource: string | null;
  agentLimit: number | null;
  apiKey: {
    id: string;
    name: string;
  };
};

async function resolvePatLookupRow(input: {
  db: ReturnType<typeof createDb>;
  authorizationHeader: string | undefined;
}): Promise<ApiKeyQueryRow> {
  const token = parseBearerPat(input.authorizationHeader);
  const tokenHash = await hashApiKeyToken(token);
  const tokenPrefix = deriveApiKeyLookupPrefix(token);

  const lookupResult = await input.db
    .select({
      api_key_id: api_keys.id,
      key_hash: api_keys.key_hash,
      api_key_status: api_keys.status,
      api_key_name: api_keys.name,
      human_id: humans.id,
      human_did: humans.did,
      human_display_name: humans.display_name,
      human_role: humans.role,
      human_status: humans.status,
      human_onboarding_source: humans.onboarding_source,
      human_agent_limit: humans.agent_limit,
    })
    .from(api_keys)
    .innerJoin(humans, eq(humans.id, api_keys.human_id))
    .where(eq(api_keys.key_prefix, tokenPrefix));

  const matchedRow =
    lookupResult.find((row: ApiKeyQueryRow) =>
      constantTimeEqual(row.key_hash, tokenHash),
    ) ?? undefined;

  if (!matchedRow) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "API key is invalid",
      status: 401,
      expose: true,
    });
  }

  if (matchedRow.api_key_status !== "active") {
    throw new AppError({
      code: "API_KEY_REVOKED",
      message: "API key is revoked",
      status: 401,
      expose: true,
    });
  }

  if (matchedRow.human_status !== "active") {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "API key is invalid",
      status: 401,
      expose: true,
    });
  }

  return matchedRow;
}

function toAuthenticatedHuman(row: ApiKeyQueryRow): AuthenticatedHuman {
  return {
    id: row.human_id,
    did: row.human_did,
    displayName: row.human_display_name,
    role: row.human_role,
    onboardingSource: row.human_onboarding_source,
    agentLimit: row.human_agent_limit,
    apiKey: {
      id: row.api_key_id,
      name: row.api_key_name,
    },
  };
}

export async function resolvePatHuman(input: {
  db: ReturnType<typeof createDb>;
  authorizationHeader: string | undefined;
  touchLastUsed?: boolean;
}): Promise<AuthenticatedHuman> {
  const matchedRow = await resolvePatLookupRow({
    db: input.db,
    authorizationHeader: input.authorizationHeader,
  });

  if (input.touchLastUsed === true) {
    await input.db
      .update(api_keys)
      .set({ last_used_at: nowIso() })
      .where(eq(api_keys.id, matchedRow.api_key_id));
  }

  return toAuthenticatedHuman(matchedRow);
}

export function createApiKeyAuth() {
  return createMiddleware<{
    Bindings: { DB: D1Database };
    Variables: { human: AuthenticatedHuman };
  }>(async (c, next) => {
    const db = createDb(c.env.DB);

    c.set(
      "human",
      await resolvePatHuman({
        db,
        authorizationHeader: c.req.header("authorization"),
        touchLastUsed: true,
      }),
    );

    await next();
  });
}

export { deriveApiKeyLookupPrefix, hashApiKeyToken };
