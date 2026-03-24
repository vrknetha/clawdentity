import { REGISTRY_METADATA_PATH } from "@clawdentity/protocol";
import { AppError, nowUtcMs, signCRL } from "@clawdentity/sdk";
import { desc, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { resolveRegistryIssuer } from "../../agent-registration.js";
import {
  agentResolveNotFoundError,
  mapResolvedAgentRow,
  parseAgentResolvePath,
} from "../../agent-resolve.js";
import { createDb } from "../../db/client.js";
import { agents, humans, revocations } from "../../db/schema.js";
import { resolveRegistrySigner } from "../../registry-signer.js";
import {
  REGISTRY_CRL_CACHE_CONTROL,
  REGISTRY_KEY_CACHE_CONTROL,
  type RegistryRouteDependencies,
} from "../constants.js";
import {
  buildCrlClaims,
  resolvePublicProxyUrl,
  resolvePublicRegistryIssuer,
  resolveRequestOrigin,
} from "../helpers/parsers.js";

export function registerHealthRoutes(
  input: RegistryRouteDependencies & {
    resolveRateLimit: MiddlewareHandler;
    crlRateLimit: MiddlewareHandler;
  },
): void {
  const { app, getConfig, crlRateLimit, resolveRateLimit } = input;

  app.get("/health", (c) => {
    const config = getConfig(c.env);
    const readiness = {
      versionSource: config.APP_VERSION ? "APP_VERSION" : "fallback",
      dbBindingConfigured: c.env.DB !== undefined,
      eventBusBackendConfigured: config.EVENT_BUS_BACKEND !== undefined,
      eventBusBindingConfigured:
        config.EVENT_BUS_BACKEND !== "queue" ||
        c.env.EVENT_BUS_QUEUE !== undefined,
      proxyUrlConfigured: typeof config.PROXY_URL === "string",
      issuerUrlConfigured: typeof config.REGISTRY_ISSUER_URL === "string",
      landingUrlConfigured: typeof config.LANDING_URL === "string",
      bootstrapSecretConfigured: typeof config.BOOTSTRAP_SECRET === "string",
      internalServiceCredentialsConfigured:
        typeof config.BOOTSTRAP_INTERNAL_SERVICE_ID === "string" &&
        typeof config.BOOTSTRAP_INTERNAL_SERVICE_SECRET === "string",
      githubOnboardingConfigured:
        typeof config.GITHUB_CLIENT_ID === "string" &&
        typeof config.GITHUB_CLIENT_SECRET === "string" &&
        typeof config.GITHUB_OAUTH_STATE_SECRET === "string",
      signingConfigured:
        typeof config.REGISTRY_SIGNING_KEY === "string" &&
        Array.isArray(config.REGISTRY_SIGNING_KEYS) &&
        config.REGISTRY_SIGNING_KEYS.length > 0,
    };

    return c.json({
      status: "ok",
      ready: Object.entries(readiness).every(([, value]) =>
        typeof value === "boolean" ? value : true,
      ),
      version: config.APP_VERSION ?? "0.0.0",
      environment: config.ENVIRONMENT,
      readiness,
    });
  });

  app.get(REGISTRY_METADATA_PATH, (c) => {
    const config = getConfig(c.env);
    return c.json({
      status: "ok",
      environment: config.ENVIRONMENT,
      version: config.APP_VERSION ?? "0.0.0",
      registryUrl: resolveRequestOrigin(c.req.raw),
      proxyUrl: resolvePublicProxyUrl({
        request: c.req.raw,
        config,
      }),
    });
  });

  app.get("/.well-known/claw-keys.json", (c) => {
    const config = getConfig(c.env);
    return c.json(
      {
        keys: config.REGISTRY_SIGNING_KEYS ?? [],
      },
      200,
      {
        "Cache-Control": REGISTRY_KEY_CACHE_CONTROL,
      },
    );
  });

  app.get("/v1/crl", crlRateLimit, async (c) => {
    const config = getConfig(c.env);
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        id: revocations.id,
        jti: revocations.jti,
        reason: revocations.reason,
        revoked_at: revocations.revoked_at,
        agent_did: agents.did,
      })
      .from(revocations)
      .innerJoin(agents, eq(revocations.agent_id, agents.id))
      .orderBy(desc(revocations.revoked_at), desc(revocations.id));

    if (rows.length === 0) {
      throw new AppError({
        code: "CRL_NOT_FOUND",
        message: "CRL snapshot is not available",
        status: 404,
        expose: true,
      });
    }

    const signer = await resolveRegistrySigner(config);
    const nowSeconds = Math.floor(nowUtcMs() / 1000);
    const claims = buildCrlClaims({
      rows,
      environment: config.ENVIRONMENT,
      issuer: resolvePublicRegistryIssuer({
        request: c.req.raw,
        config,
      }),
      nowSeconds,
    });
    const crl = await signCRL({
      claims,
      signerKid: signer.signerKid,
      signerKeypair: signer.signerKeypair,
    });

    return c.json({ crl }, 200, {
      "Cache-Control": REGISTRY_CRL_CACHE_CONTROL,
    });
  });

  app.get("/v1/resolve/:id", resolveRateLimit, async (c) => {
    const config = getConfig(c.env);
    const id = parseAgentResolvePath({
      id: c.req.param("id"),
      environment: config.ENVIRONMENT,
    });
    const db = createDb(c.env.DB);

    const rows = await db
      .select({
        did: agents.did,
        name: agents.name,
        framework: agents.framework,
        status: agents.status,
        owner_did: humans.did,
      })
      .from(agents)
      .innerJoin(humans, eq(agents.owner_id, humans.id))
      .where(eq(agents.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw agentResolveNotFoundError();
    }

    return c.json(mapResolvedAgentRow(row));
  });
}
