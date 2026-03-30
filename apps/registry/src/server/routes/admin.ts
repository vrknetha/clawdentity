import {
  ADMIN_BOOTSTRAP_PATH,
  generateUlid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { eq } from "drizzle-orm";
import { parseAdminBootstrapPayload } from "../../admin-bootstrap.js";
import { resolveDidAuthorityFromIssuer } from "../../agent-registration.js";
import {
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../auth/api-key-token.js";
import {
  deriveInternalServiceSecretPrefix,
  hashInternalServiceSecret,
} from "../../auth/service-auth.js";
import { createDb } from "../../db/client.js";
import { api_keys, humans, internal_services } from "../../db/schema.js";
import {
  BOOTSTRAP_ADMIN_HUMAN_ID,
  logger,
  type RegistryRouteDependencies,
} from "../constants.js";
import { DB_MUTATION_OPERATION } from "../helpers/db-mutation-operations.js";
import {
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
} from "../helpers/db-queries.js";
import {
  adminBootstrapAlreadyCompletedError,
  assertBootstrapSecretAuthorized,
  parseBootstrapSecretHeader,
  requireBootstrapSecret,
  resolvePublicRegistryIssuer,
} from "../helpers/parsers.js";

const BOOTSTRAP_INTERNAL_SERVICE_NAME = "proxy-pairing";
const BOOTSTRAP_INTERNAL_SERVICE_SCOPES = [
  "identity.read",
  "groups.read",
] as const;

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

    const issuer = resolvePublicRegistryIssuer({
      request: c.req.raw,
      config,
    });
    const didAuthority = resolveDidAuthorityFromIssuer(issuer);
    const humanId = BOOTSTRAP_ADMIN_HUMAN_ID;
    const humanDid = makeHumanDid(didAuthority, humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowUtcMs() + 1);
    const createdAt = nowIso();
    const internalServiceId = config.BOOTSTRAP_INTERNAL_SERVICE_ID.trim();
    const internalServiceSecret =
      config.BOOTSTRAP_INTERNAL_SERVICE_SECRET.trim();

    if (internalServiceId.length === 0 || internalServiceSecret.length === 0) {
      throw new AppError({
        code: "CONFIG_VALIDATION_FAILED",
        message: "Registry configuration is invalid",
        status: 500,
        expose: true,
        details: {
          fieldErrors: {
            BOOTSTRAP_INTERNAL_SERVICE_ID: [
              "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
            ],
            BOOTSTRAP_INTERNAL_SERVICE_SECRET: [
              "BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET must be set together.",
            ],
          },
          formErrors: [],
        },
      });
    }

    let internalServiceSecretHash: string;
    let internalServiceSecretPrefix: string;
    try {
      internalServiceSecretHash = await hashInternalServiceSecret(
        internalServiceSecret,
      );
      internalServiceSecretPrefix = deriveInternalServiceSecretPrefix(
        internalServiceSecret,
      );
    } catch {
      throw new AppError({
        code: "CONFIG_VALIDATION_FAILED",
        message: "Registry configuration is invalid",
        status: 500,
        expose: true,
        details: {
          fieldErrors: {
            BOOTSTRAP_INTERNAL_SERVICE_SECRET: [
              "BOOTSTRAP_INTERNAL_SERVICE_SECRET must start with clw_srv_.",
            ],
          },
          formErrors: [],
        },
      });
    }

    const rollbackBootstrapMutation = async (
      executor: typeof db,
      reason: "api_key_insert" | "internal_service_insert",
    ): Promise<void> => {
      try {
        await executor
          .delete(internal_services)
          .where(eq(internal_services.id, internalServiceId));
      } catch (rollbackError) {
        logger.error("registry.admin_bootstrap_rollback_failed", {
          reason,
          target: "internal_services",
          rollbackErrorName:
            rollbackError instanceof Error ? rollbackError.name : "unknown",
        });
      }

      try {
        await executor.delete(api_keys).where(eq(api_keys.id, apiKeyId));
      } catch (rollbackError) {
        logger.error("registry.admin_bootstrap_rollback_failed", {
          reason,
          target: "api_keys",
          rollbackErrorName:
            rollbackError instanceof Error ? rollbackError.name : "unknown",
        });
      }

      try {
        await executor.delete(humans).where(eq(humans.id, humanId));
      } catch (rollbackError) {
        logger.error("registry.admin_bootstrap_rollback_failed", {
          reason,
          target: "humans",
          rollbackErrorName:
            rollbackError instanceof Error ? rollbackError.name : "unknown",
        });
      }
    };

    const applyBootstrapMutation = async (
      executor: typeof db,
      options: { rollbackOnFailure: boolean },
    ): Promise<void> => {
      const insertAdminResult = await executor
        .insert(humans)
        .values({
          id: humanId,
          did: humanDid,
          display_name: bootstrapPayload.displayName,
          role: "admin",
          status: "active",
          onboarding_source: "admin_bootstrap",
          agent_limit: null,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflictDoNothing({
          target: humans.id,
        });

      const insertedRows = getMutationRowCount({
        result: insertAdminResult,
        operation: DB_MUTATION_OPERATION.ADMIN_BOOTSTRAP_HUMAN_INSERT,
      });
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
        if (options.rollbackOnFailure) {
          await rollbackBootstrapMutation(executor, "api_key_insert");
        }

        throw error;
      }

      try {
        await executor.insert(internal_services).values({
          id: internalServiceId,
          name: BOOTSTRAP_INTERNAL_SERVICE_NAME,
          secret_hash: internalServiceSecretHash,
          secret_prefix: internalServiceSecretPrefix,
          scopes_json: JSON.stringify(BOOTSTRAP_INTERNAL_SERVICE_SCOPES),
          status: "active",
          created_by: humanId,
          rotated_at: null,
          last_used_at: null,
          created_at: createdAt,
          updated_at: createdAt,
        });
      } catch (error) {
        if (options.rollbackOnFailure) {
          await rollbackBootstrapMutation(executor, "internal_service_insert");
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyBootstrapMutation(tx as unknown as typeof db, {
          rollbackOnFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyBootstrapMutation(db, {
        rollbackOnFailure: true,
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
        internalService: {
          id: internalServiceId,
          name: BOOTSTRAP_INTERNAL_SERVICE_NAME,
        },
      },
      201,
    );
  });
}
