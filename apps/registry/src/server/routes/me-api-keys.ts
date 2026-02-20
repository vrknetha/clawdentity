import { generateUlid, ME_API_KEYS_PATH } from "@clawdentity/protocol";
import {
  AppError,
  nowIso,
  nowUtcMs,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import { and, desc, eq } from "drizzle-orm";
import {
  apiKeyNotFoundError,
  mapApiKeyMetadataRow,
  parseApiKeyCreatePayload,
  parseApiKeyRevokePath,
} from "../../api-key-lifecycle.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import {
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../auth/api-key-token.js";
import { createDb } from "../../db/client.js";
import { api_keys } from "../../db/schema.js";
import type { RegistryRouteDependencies } from "../constants.js";

export function registerMeApiKeyRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig } = input;

  app.get("/v1/me", createApiKeyAuth(), (c) => {
    return c.json({ human: c.get("human") });
  });

  app.post(ME_API_KEYS_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown = {};
    try {
      const rawBody = await c.req.text();
      if (rawBody.trim().length > 0) {
        payload = JSON.parse(rawBody);
      }
    } catch {
      throw new AppError({
        code: "API_KEY_CREATE_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseApiKeyCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const human = c.get("human");
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowUtcMs() + 1);
    const createdAt = nowIso();

    const db = createDb(c.env.DB);
    await db.insert(api_keys).values({
      id: apiKeyId,
      human_id: human.id,
      key_hash: apiKeyHash,
      key_prefix: apiKeyPrefix,
      name: parsedPayload.name,
      status: "active",
      created_at: createdAt,
      last_used_at: null,
    });

    return c.json(
      {
        apiKey: {
          id: apiKeyId,
          name: parsedPayload.name,
          status: "active",
          createdAt,
          lastUsedAt: null,
          token: apiKeyToken,
        },
      },
      201,
    );
  });

  app.get(ME_API_KEYS_PATH, createApiKeyAuth(), async (c) => {
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: api_keys.id,
        name: api_keys.name,
        status: api_keys.status,
        created_at: api_keys.created_at,
        last_used_at: api_keys.last_used_at,
      })
      .from(api_keys)
      .where(eq(api_keys.human_id, human.id))
      .orderBy(desc(api_keys.created_at), desc(api_keys.id));

    return c.json({
      apiKeys: rows.map(mapApiKeyMetadataRow),
    });
  });

  app.delete(`${ME_API_KEYS_PATH}/:id`, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const apiKeyId = parseApiKeyRevokePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const human = c.get("human");
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: api_keys.id,
        status: api_keys.status,
      })
      .from(api_keys)
      .where(and(eq(api_keys.id, apiKeyId), eq(api_keys.human_id, human.id)))
      .limit(1);

    const existingKey = rows[0];
    if (!existingKey) {
      throw apiKeyNotFoundError();
    }

    if (existingKey.status === "revoked") {
      return c.body(null, 204);
    }

    await db
      .update(api_keys)
      .set({
        status: "revoked",
      })
      .where(and(eq(api_keys.id, apiKeyId), eq(api_keys.human_id, human.id)));

    return c.body(null, 204);
  });
}
