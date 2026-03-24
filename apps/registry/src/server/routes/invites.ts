import {
  generateUlid,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
  makeHumanDid,
} from "@clawdentity/protocol";
import {
  AppError,
  nowIso,
  nowUtcMs,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import { and, eq, isNull } from "drizzle-orm";
import {
  resolveDidAuthorityFromIssuer,
  resolveRegistryIssuer,
} from "../../agent-registration.js";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import {
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../auth/api-key-token.js";
import { createDb } from "../../db/client.js";
import { api_keys, humans, invites } from "../../db/schema.js";
import {
  generateInviteCode,
  inviteCreateForbiddenError,
  inviteRedeemAlreadyUsedError,
  inviteRedeemCodeInvalidError,
  inviteRedeemExpiredError,
  parseInviteCreatePayload,
  parseInviteRedeemPayload,
} from "../../invite-lifecycle.js";
import { logger, type RegistryRouteDependencies } from "../constants.js";
import {
  findInviteByCode,
  getMutationRowCount,
  isInviteExpired,
  isUnsupportedLocalTransactionError,
  resolveInviteRedeemStateError,
} from "../helpers/db-queries.js";
import {
  resolvePublicProxyUrl,
  resolvePublicRegistryIssuer,
} from "../helpers/parsers.js";

export function registerInviteRoutes(input: RegistryRouteDependencies): void {
  const { app, getConfig } = input;

  app.post(INVITES_PATH, createApiKeyAuth(), async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "INVITE_CREATE_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const human = c.get("human");
    if (human.role !== "admin") {
      throw inviteCreateForbiddenError();
    }

    const parsedPayload = parseInviteCreatePayload({
      payload,
      environment: config.ENVIRONMENT,
      nowMs: nowUtcMs(),
    });

    const inviteId = generateUlid(nowUtcMs());
    const inviteCode = generateInviteCode();
    const createdAt = nowIso();
    const db = createDb(c.env.DB);
    await db.insert(invites).values({
      id: inviteId,
      code: inviteCode,
      created_by: human.id,
      redeemed_by: null,
      agent_id: null,
      expires_at: parsedPayload.expiresAt,
      created_at: createdAt,
    });

    return c.json(
      {
        invite: {
          id: inviteId,
          code: inviteCode,
          createdBy: human.id,
          expiresAt: parsedPayload.expiresAt,
          createdAt,
        },
      },
      201,
    );
  });

  app.post(INVITES_REDEEM_PATH, async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "INVITE_REDEEM_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseInviteRedeemPayload({
      payload,
      environment: config.ENVIRONMENT,
    });

    const db = createDb(c.env.DB);
    const invite = await findInviteByCode({
      db,
      code: parsedPayload.code,
    });

    if (!invite) {
      throw inviteRedeemCodeInvalidError();
    }

    const nowMillis = nowUtcMs();
    if (invite.redeemed_by !== null) {
      throw inviteRedeemAlreadyUsedError();
    }

    if (
      isInviteExpired({
        expiresAt: invite.expires_at,
        nowMillis,
      })
    ) {
      throw inviteRedeemExpiredError();
    }

    const issuer = resolvePublicRegistryIssuer({
      request: c.req.raw,
      config,
    });
    const didAuthority = resolveDidAuthorityFromIssuer(issuer);
    const humanId = generateUlid(nowMillis);
    const humanDid = makeHumanDid(didAuthority, humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowMillis + 1);
    const createdAt = nowIso();

    const applyRedeemMutation = async (
      executor: typeof db,
      options: { rollbackOnFailure: boolean },
    ): Promise<void> => {
      await executor.insert(humans).values({
        id: humanId,
        did: humanDid,
        display_name: parsedPayload.displayName,
        role: "user",
        status: "active",
        onboarding_source: "invite",
        agent_limit: null,
        created_at: createdAt,
        updated_at: createdAt,
      });

      let inviteRedeemed = false;
      try {
        const inviteUpdateResult = await executor
          .update(invites)
          .set({
            redeemed_by: humanId,
          })
          .where(and(eq(invites.id, invite.id), isNull(invites.redeemed_by)));

        const updatedRows = getMutationRowCount(inviteUpdateResult);
        if (updatedRows === 0) {
          throw await resolveInviteRedeemStateError({
            db: executor,
            inviteId: invite.id,
            nowMillis,
          });
        }
        inviteRedeemed = true;

        await executor.insert(api_keys).values({
          id: apiKeyId,
          human_id: humanId,
          key_hash: apiKeyHash,
          key_prefix: apiKeyPrefix,
          name: parsedPayload.apiKeyName,
          status: "active",
          created_at: createdAt,
          last_used_at: null,
        });
      } catch (error) {
        if (options.rollbackOnFailure) {
          if (inviteRedeemed) {
            try {
              await executor
                .update(invites)
                .set({
                  redeemed_by: null,
                })
                .where(
                  and(
                    eq(invites.id, invite.id),
                    eq(invites.redeemed_by, humanId),
                  ),
                );
            } catch (rollbackError) {
              logger.error("registry.invite_redeem_rollback_failed", {
                rollbackErrorName:
                  rollbackError instanceof Error
                    ? rollbackError.name
                    : "unknown",
                stage: "invite_unlink",
              });
            }
          }

          try {
            await executor.delete(humans).where(eq(humans.id, humanId));
          } catch (rollbackError) {
            logger.error("registry.invite_redeem_rollback_failed", {
              rollbackErrorName:
                rollbackError instanceof Error ? rollbackError.name : "unknown",
              stage: "human_delete",
            });
          }
        }

        throw error;
      }
    };

    try {
      await db.transaction(async (tx) => {
        await applyRedeemMutation(tx as unknown as typeof db, {
          rollbackOnFailure: false,
        });
      });
    } catch (error) {
      if (!isUnsupportedLocalTransactionError(error)) {
        throw error;
      }

      await applyRedeemMutation(db, {
        rollbackOnFailure: true,
      });
    }

    return c.json(
      {
        human: {
          id: humanId,
          did: humanDid,
          displayName: parsedPayload.displayName,
          role: "user",
          status: "active",
        },
        apiKey: {
          id: apiKeyId,
          name: parsedPayload.apiKeyName,
          token: apiKeyToken,
        },
        proxyUrl: resolvePublicProxyUrl({
          request: c.req.raw,
          config,
        }),
      },
      201,
    );
  });
}
