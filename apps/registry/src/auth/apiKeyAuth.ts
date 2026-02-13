import { AppError, nowIso } from "@clawdentity/sdk";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db/client.js";
import { api_keys, humans } from "../db/schema.js";

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

const PAT_TOKEN_MARKER = "clw_pat_";
const PAT_LOOKUP_ENTROPY_LENGTH = 8;

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

function parseBearerPat(authorization?: string): string {
  if (!authorization) {
    throw new AppError({
      code: "API_KEY_MISSING",
      message: "Authorization header is required",
      status: 401,
      expose: true,
    });
  }

  const [scheme, token] = authorization.trim().split(/\s+/, 2);
  if (scheme !== "Bearer" || !token) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must be in the format 'Bearer <pat>'",
      status: 401,
      expose: true,
    });
  }

  if (!token.startsWith(PAT_TOKEN_MARKER)) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must contain a PAT token",
      status: 401,
      expose: true,
    });
  }

  if (token.length <= PAT_TOKEN_MARKER.length) {
    throw new AppError({
      code: "API_KEY_INVALID",
      message: "Authorization must contain a PAT token",
      status: 401,
      expose: true,
    });
  }

  return token;
}

export function deriveApiKeyLookupPrefix(token: string): string {
  const entropyPrefix = token.slice(
    PAT_TOKEN_MARKER.length,
    PAT_TOKEN_MARKER.length + PAT_LOOKUP_ENTROPY_LENGTH,
  );

  return `${PAT_TOKEN_MARKER}${entropyPrefix}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

export async function hashApiKeyToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

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
