import {
  ADMIN_BOOTSTRAP_PATH,
  generateUlid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { eq } from "drizzle-orm";
import { parseAdminBootstrapPayload } from "../../admin-bootstrap.js";
import {
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../auth/api-key-token.js";
import { createDb } from "../../db/client.js";
import { api_keys, humans } from "../../db/schema.js";
import {
  BOOTSTRAP_ADMIN_HUMAN_ID,
  logger,
  type RegistryRouteDependencies,
} from "../constants.js";
import {
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
} from "../helpers/db-queries.js";
import {
  adminBootstrapAlreadyCompletedError,
  assertBootstrapSecretAuthorized,
  parseBootstrapSecretHeader,
  requireBootstrapSecret,
} from "../helpers/parsers.js";

export function registerAdminRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig } = input;

  app.post(ADMIN_BOOTSTRAP_PATH, async (c) => {
    const config = getConfig(c.env);
    const expectedBootstrapSecret = requireBootstrapSecret(
      config.BOOTSTRAP_SECRET,
    );
    const providedBootstrapSecret = parseBootstrapSecretHeader(
      c.req.header("x-bootstrap-secret"),
    );
    assertBootstrapSecretAuthorized({
      provided: providedBootstrapSecret,
      expected: expectedBootstrapSecret,
    });

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "ADMIN_BOOTSTRAP_INVALID",
        message: "Request body must be valid JSON",
        status: 400,
        expose: true,
      });
    }

    const bootstrapPayload = parseAdminBootstrapPayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const db = createDb(c.env.DB);
    const activeAdminRows = await db
      .select({ id: humans.id })
      .from(humans)
      .where(eq(humans.role, "admin"))
      .limit(1);
    if (activeAdminRows.length > 0) {
      throw adminBootstrapAlreadyCompletedError();
    }

    const humanId = BOOTSTRAP_ADMIN_HUMAN_ID;
    const humanDid = makeHumanDid(humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowUtcMs() + 1);
    const createdAt = nowIso();

    const applyBootstrapMutation = async (
      executor: typeof db,
      options: { rollbackOnApiKeyFailure: boolean },
    ): Promise<void> => {
      const insertAdminResult = await executor
        .insert(humans)
        .values({
          id: humanId,
          did: humanDid,
          display_name: bootstrapPayload.displayName,
          role: "admin",
          status: "active",
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflictDoNothing({
          target: humans.id,
        });

      const insertedRows = getMutationRowCount(insertAdminResult);
      if (insertedRows === 0) {
        throw adminBootstrapAlreadyCompletedError();
      }

      try {
        await executor.insert(api_keys).values({
          id: apiKeyId,
          human_id: humanId,
          key_hash: apiKeyHash,
          key_prefix: apiKeyPrefix,
          name: bootstrapPayload.apiKeyName,
          status: "active",
          created_at: createdAt,
          last_used_at: null,
        });
      } catch (error) {
        if (options.rollbackOnApiKeyFailure) {
          try {
            await executor.delete(humans).where(eq(humans.id, humanId));
          } catch (rollbackError) {
            logger.error("registry.admin_bootstrap_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
            });
          }
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyBootstrapMutation(tx as unknown as typeof db, {
          rollbackOnApiKeyFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyBootstrapMutation(db, {
        rollbackOnApiKeyFailure: true,
      });
    }

    return c.json(
      {
        human: {
          id: humanId,
          did: humanDid,
          displayName: bootstrapPayload.displayName,
          role: "admin",
          status: "active",
        },
        apiKey: {
          id: apiKeyId,
          name: bootstrapPayload.apiKeyName,
          token: apiKeyToken,
        },
      },
      201,
    );
  });
}
