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
};

export type AuthenticatedHuman = {
  id: string;
  did: string;
  displayName: string;
  role: "admin" | "user";
  apiKey: {
    id: string;
    name: string;
  };
};

export function createApiKeyAuth() {
  return createMiddleware<{
    Bindings: { DB: D1Database };
    Variables: { human: AuthenticatedHuman };
  }>(async (c, next) => {
    const db = createDb(c.env.DB);
    const token = parseBearerPat(c.req.header("authorization"));
    const tokenHash = await hashApiKeyToken(token);
    const tokenPrefix = deriveApiKeyLookupPrefix(token);

    const lookupResult = await db
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

    await db
      .update(api_keys)
      .set({ last_used_at: nowIso() })
      .where(eq(api_keys.id, matchedRow.api_key_id));

    c.set("human", {
      id: matchedRow.human_id,
      did: matchedRow.human_did,
      displayName: matchedRow.human_display_name,
      role: matchedRow.human_role,
      apiKey: {
        id: matchedRow.api_key_id,
        name: matchedRow.api_key_name,
      },
    });

    await next();
  });
}

export { deriveApiKeyLookupPrefix, hashApiKeyToken };
