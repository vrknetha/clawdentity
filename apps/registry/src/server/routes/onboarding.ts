import {
  GITHUB_ONBOARDING_CALLBACK_PATH,
  GITHUB_ONBOARDING_START_PATH,
  generateUlid,
  makeHumanDid,
  STARTER_PASSES_REDEEM_PATH,
} from "@clawdentity/protocol";
import {
  AppError,
  nowIso,
  nowUtcMs,
  shouldExposeVerboseErrors,
} from "@clawdentity/sdk";
import { and, eq, isNull } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  resolveDidAuthorityFromIssuer,
  resolveRegistryIssuer,
} from "../../agent-registration.js";
import {
  deriveApiKeyLookupPrefix,
  generateApiKeyToken,
  hashApiKeyToken,
} from "../../auth/api-key-token.js";
import { createDb } from "../../db/client.js";
import { api_keys, humans, starter_passes } from "../../db/schema.js";
import {
  buildGithubAuthorizeUrl,
  buildOnboardingRedirectUrl,
  createSignedGithubStateCookie,
  exchangeGithubCode,
  fetchGithubProfile,
  getGithubStateCookieName,
  verifySignedGithubStateCookie,
} from "../../onboarding/github.js";
import {
  computeStarterPassExpiry,
  generateStarterPassCode,
  normalizeGithubLogin,
  normalizeStarterDisplayName,
  normalizeStarterPassStatus,
  parseStarterPassRedeemPayload,
  starterPassAlreadyUsedError,
  starterPassCodeInvalidError,
  starterPassDisabledError,
  starterPassExpiredError,
} from "../../starter-pass-lifecycle.js";
import type { RegistryRouteDependencies } from "../constants.js";
import {
  findStarterPassByCode,
  findStarterPassByProviderSubject,
  getMutationRowCount,
  isUnsupportedLocalTransactionError,
  resolveStarterPassRedeemStateError,
} from "../helpers/db-queries.js";
import { resolveProxyUrl } from "../helpers/parsers.js";

const GITHUB_STARTER_PASS_PROVIDER = "github";

function redirectToOnboardingError(input: {
  config: ReturnType<RegistryRouteDependencies["getConfig"]>;
  error: string;
  message?: string;
}) {
  const fragment: Record<string, string> = { error: input.error };
  if (input.message) {
    fragment.message = input.message;
  }

  return buildOnboardingRedirectUrl({
    config: input.config,
    fragment,
  });
}

export function registerOnboardingRoutes(
  input: RegistryRouteDependencies,
): void {
  const { app, getConfig } = input;

  app.get(GITHUB_ONBOARDING_START_PATH, async (c) => {
    const config = getConfig(c.env);
    if (
      !config.GITHUB_CLIENT_ID ||
      !config.GITHUB_CLIENT_SECRET ||
      !config.GITHUB_OAUTH_STATE_SECRET
    ) {
      throw starterPassDisabledError();
    }

    const nonce = generateUlid(nowUtcMs());
    const cookieValue = await createSignedGithubStateCookie({
      config,
      nonce,
    });
    setCookie(c, getGithubStateCookieName(), cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: GITHUB_ONBOARDING_CALLBACK_PATH,
      maxAge: 10 * 60,
    });

    return c.redirect(
      buildGithubAuthorizeUrl({
        config,
        state: nonce,
      }),
      302,
    );
  });

  app.get(GITHUB_ONBOARDING_CALLBACK_PATH, async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);
    const code = c.req.query("code")?.trim();
    const state = c.req.query("state")?.trim();

    const redirectWithError = (error: string, message?: string) =>
      c.redirect(
        redirectToOnboardingError({
          config,
          error,
          message,
        }),
        302,
      );

    if (!code || !state) {
      deleteCookie(c, getGithubStateCookieName(), {
        path: GITHUB_ONBOARDING_CALLBACK_PATH,
      });
      return redirectWithError(
        "missing_callback_params",
        "GitHub onboarding callback is missing required parameters",
      );
    }

    try {
      await verifySignedGithubStateCookie({
        config,
        cookieValue: getCookie(c, getGithubStateCookieName()),
        state,
      });
      deleteCookie(c, getGithubStateCookieName(), {
        path: GITHUB_ONBOARDING_CALLBACK_PATH,
      });

      const accessToken = await exchangeGithubCode({ config, code });
      const githubProfile = await fetchGithubProfile({ accessToken });
      const nowMillis = nowUtcMs();
      const db = createDb(c.env.DB);
      const existingStarterPass = await findStarterPassByProviderSubject({
        db,
        provider: GITHUB_STARTER_PASS_PROVIDER,
        providerSubject: githubProfile.subject,
      });

      if (existingStarterPass) {
        const status = normalizeStarterPassStatus({
          status: existingStarterPass.status,
          expiresAt: existingStarterPass.expires_at,
          nowMs: nowMillis,
        });
        if (status === "active") {
          return c.redirect(
            buildOnboardingRedirectUrl({
              config,
              fragment: {
                code: existingStarterPass.code,
                displayName: existingStarterPass.display_name,
                providerLogin: existingStarterPass.provider_login,
                expiresAt: existingStarterPass.expires_at,
              },
            }),
            302,
          );
        }

        if (status === "expired" && existingStarterPass.status !== "expired") {
          await db
            .update(starter_passes)
            .set({
              status: "expired",
            })
            .where(eq(starter_passes.id, existingStarterPass.id));
        }

        return redirectWithError(
          status === "redeemed"
            ? "starter_pass_already_used"
            : "starter_pass_already_issued",
          status === "redeemed"
            ? "This GitHub account has already redeemed its one starter pass"
            : "This GitHub account has already been issued a starter pass",
        );
      }

      const issuer = resolveRegistryIssuer(config);
      const starterPassId = generateUlid(nowMillis);
      const starterPassCode = generateStarterPassCode();
      const issuedAt = nowIso();
      const expiresAt = computeStarterPassExpiry(nowMillis);
      const displayName = normalizeStarterDisplayName(
        githubProfile.displayName,
      );
      const providerLogin = normalizeGithubLogin(githubProfile.login);

      await db.insert(starter_passes).values({
        id: starterPassId,
        code: starterPassCode,
        provider: GITHUB_STARTER_PASS_PROVIDER,
        provider_subject: githubProfile.subject,
        provider_login: providerLogin,
        display_name: displayName,
        redeemed_by: null,
        issued_at: issuedAt,
        redeemed_at: null,
        expires_at: expiresAt,
        status: "active",
      });

      return c.redirect(
        buildOnboardingRedirectUrl({
          config,
          fragment: {
            code: starterPassCode,
            displayName,
            providerLogin,
            expiresAt,
            issuer,
          },
        }),
        302,
      );
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : exposeDetails
            ? error instanceof Error
              ? error.message
              : "GitHub onboarding failed"
            : "GitHub onboarding failed";

      deleteCookie(c, getGithubStateCookieName(), {
        path: GITHUB_ONBOARDING_CALLBACK_PATH,
      });
      return redirectWithError("github_onboarding_failed", message);
    }
  });

  app.post(STARTER_PASSES_REDEEM_PATH, async (c) => {
    const config = getConfig(c.env);
    const exposeDetails = shouldExposeVerboseErrors(config.ENVIRONMENT);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "STARTER_PASS_REDEEM_INVALID",
        message: exposeDetails
          ? "Request body must be valid JSON"
          : "Request could not be processed",
        status: 400,
        expose: exposeDetails,
      });
    }

    const parsedPayload = parseStarterPassRedeemPayload({
      payload,
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);
    const starterPass = await findStarterPassByCode({
      db,
      code: parsedPayload.code,
    });

    if (!starterPass) {
      throw starterPassCodeInvalidError();
    }

    const nowMillis = nowUtcMs();
    const normalizedStatus = normalizeStarterPassStatus({
      status: starterPass.status,
      expiresAt: starterPass.expires_at,
      nowMs: nowMillis,
    });
    if (normalizedStatus === "expired" && starterPass.status !== "expired") {
      await db
        .update(starter_passes)
        .set({
          status: "expired",
        })
        .where(eq(starter_passes.id, starterPass.id));
    }

    if (starterPass.redeemed_by !== null || normalizedStatus === "redeemed") {
      throw starterPassAlreadyUsedError();
    }
    if (normalizedStatus === "expired") {
      throw starterPassExpiredError();
    }

    const issuer = resolveRegistryIssuer(config);
    const didAuthority = resolveDidAuthorityFromIssuer(issuer);
    const humanId = generateUlid(nowMillis);
    const humanDid = makeHumanDid(didAuthority, humanId);
    const apiKeyToken = generateApiKeyToken();
    const apiKeyHash = await hashApiKeyToken(apiKeyToken);
    const apiKeyPrefix = deriveApiKeyLookupPrefix(apiKeyToken);
    const apiKeyId = generateUlid(nowMillis + 1);
    const createdAt = nowIso();
    const redeemedAt = createdAt;

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
        onboarding_source: "github_starter_pass",
        agent_limit: 1,
        created_at: createdAt,
        updated_at: createdAt,
      });

      let starterPassRedeemed = false;
      try {
        const starterPassUpdateResult = await executor
          .update(starter_passes)
          .set({
            redeemed_by: humanId,
            redeemed_at: redeemedAt,
            status: "redeemed",
          })
          .where(
            and(
              eq(starter_passes.id, starterPass.id),
              eq(starter_passes.status, "active"),
              isNull(starter_passes.redeemed_by),
            ),
          );

        const updatedRows = getMutationRowCount(starterPassUpdateResult);
        if (updatedRows === 0) {
          throw await resolveStarterPassRedeemStateError({
            db: executor,
            starterPassId: starterPass.id,
            nowMillis,
          });
        }
        starterPassRedeemed = true;

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
          if (starterPassRedeemed) {
            await executor
              .update(starter_passes)
              .set({
                redeemed_by: null,
                redeemed_at: null,
                status: "active",
              })
              .where(
                and(
                  eq(starter_passes.id, starterPass.id),
                  eq(starter_passes.redeemed_by, humanId),
                ),
              );
          }
          await executor.delete(humans).where(eq(humans.id, humanId));
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
        proxyUrl: resolveProxyUrl(config),
      },
      201,
    );
  });
}
