import {
  ADMIN_INTERNAL_SERVICES_PATH,
  generateUlid,
  INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
} from "@clawdentity/protocol";
import { AppError, nowIso, nowUtcMs } from "@clawdentity/sdk";
import { desc, eq } from "drizzle-orm";
import { createApiKeyAuth } from "../../auth/api-key-auth.js";
import {
  createServiceAuth,
  deriveInternalServiceSecretPrefix,
  generateInternalServiceSecret,
  hashInternalServiceSecret,
} from "../../auth/service-auth.js";
import { createDb } from "../../db/client.js";
import { agents, humans, internal_services } from "../../db/schema.js";
import type { RegistryRouteDependencies } from "../constants.js";
import {
  parseInternalOwnershipCheckPayload,
  parseInternalServiceCreatePayload,
  parseInternalServicePathId,
  parseInternalServiceRotatePayload,
} from "../helpers/parsers.js";

export function registerInternalServiceRoutes(
  input: RegistryRouteDependencies,
): void {
  const { app, getConfig } = input;

  app.post(ADMIN_INTERNAL_SERVICES_PATH, createApiKeyAuth(), async (c) => {
    const human = c.get("human");
    if (human.role !== "admin") {
      throw new AppError({
        code: "INTERNAL_SERVICE_CREATE_FORBIDDEN",
        message: "Admin role is required",
        status: 403,
        expose: true,
      });
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "INTERNAL_SERVICE_INVALID",
        message: "Internal service payload is invalid",
        status: 400,
        expose: true,
      });
    }

    const parsed = parseInternalServiceCreatePayload(payload);
    const db = createDb(c.env.DB);
    const existingRows = await db
      .select({
        id: internal_services.id,
      })
      .from(internal_services)
      .where(eq(internal_services.name, parsed.name))
      .limit(1);
    if (existingRows[0]) {
      throw new AppError({
        code: "INTERNAL_SERVICE_ALREADY_EXISTS",
        message: "Internal service already exists",
        status: 409,
        expose: true,
      });
    }

    const secret = generateInternalServiceSecret();
    const secretHash = await hashInternalServiceSecret(secret);
    const secretPrefix = deriveInternalServiceSecretPrefix(secret);
    const createdAt = nowIso();
    const serviceId = generateUlid(nowUtcMs());
    await db.insert(internal_services).values({
      id: serviceId,
      name: parsed.name,
      secret_hash: secretHash,
      secret_prefix: secretPrefix,
      scopes_json: JSON.stringify(parsed.scopes),
      status: "active",
      created_by: human.id,
      rotated_at: null,
      last_used_at: null,
      created_at: createdAt,
      updated_at: createdAt,
    });

    return c.json(
      {
        internalService: {
          id: serviceId,
          name: parsed.name,
          scopes: parsed.scopes,
          status: "active",
          createdAt,
          updatedAt: createdAt,
          rotatedAt: null,
          lastUsedAt: null,
          secret,
        },
      },
      201,
    );
  });

  app.get(ADMIN_INTERNAL_SERVICES_PATH, createApiKeyAuth(), async (c) => {
    const human = c.get("human");
    if (human.role !== "admin") {
      throw new AppError({
        code: "INTERNAL_SERVICE_LIST_FORBIDDEN",
        message: "Admin role is required",
        status: 403,
        expose: true,
      });
    }

    const db = createDb(c.env.DB);
    const rows = await db
      .select({
        id: internal_services.id,
        name: internal_services.name,
        scopesJson: internal_services.scopes_json,
        status: internal_services.status,
        createdAt: internal_services.created_at,
        updatedAt: internal_services.updated_at,
        rotatedAt: internal_services.rotated_at,
        lastUsedAt: internal_services.last_used_at,
      })
      .from(internal_services)
      .orderBy(desc(internal_services.created_at), desc(internal_services.id));

    return c.json({
      internalServices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        scopes: JSON.parse(row.scopesJson) as string[],
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        rotatedAt: row.rotatedAt,
        lastUsedAt: row.lastUsedAt,
      })),
    });
  });

  app.post(
    `${ADMIN_INTERNAL_SERVICES_PATH}/:id/rotate`,
    createApiKeyAuth(),
    async (c) => {
      const config = getConfig(c.env);
      const human = c.get("human");
      if (human.role !== "admin") {
        throw new AppError({
          code: "INTERNAL_SERVICE_ROTATE_FORBIDDEN",
          message: "Admin role is required",
          status: 403,
          expose: true,
        });
      }

      const serviceId = parseInternalServicePathId({
        id: c.req.param("id"),
        environment: config.ENVIRONMENT,
      });

      let payload: unknown = {};
      try {
        const rawBody = await c.req.text();
        if (rawBody.trim().length > 0) {
          payload = JSON.parse(rawBody);
        }
      } catch {
        throw new AppError({
          code: "INTERNAL_SERVICE_INVALID",
          message: "Internal service payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const parsedPayload = parseInternalServiceRotatePayload(payload);
      const db = createDb(c.env.DB);
      const rows = await db
        .select({
          id: internal_services.id,
          name: internal_services.name,
          scopesJson: internal_services.scopes_json,
          status: internal_services.status,
        })
        .from(internal_services)
        .where(eq(internal_services.id, serviceId))
        .limit(1);
      const service = rows[0];
      if (!service) {
        throw new AppError({
          code: "INTERNAL_SERVICE_NOT_FOUND",
          message: "Internal service was not found",
          status: 404,
          expose: true,
        });
      }
      if (service.status !== "active") {
        throw new AppError({
          code: "INTERNAL_SERVICE_INVALID_STATE",
          message: "Internal service cannot be rotated",
          status: 409,
          expose: true,
        });
      }

      const scopes =
        parsedPayload.scopes ??
        ((JSON.parse(service.scopesJson) as unknown[]).filter(
          (scope): scope is string =>
            typeof scope === "string" && scope.trim().length > 0,
        ) as string[]);
      if (scopes.length === 0) {
        throw new AppError({
          code: "INTERNAL_SERVICE_INVALID",
          message: "Internal service payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const secret = generateInternalServiceSecret();
      const secretHash = await hashInternalServiceSecret(secret);
      const secretPrefix = deriveInternalServiceSecretPrefix(secret);
      const rotatedAt = nowIso();
      await db
        .update(internal_services)
        .set({
          secret_hash: secretHash,
          secret_prefix: secretPrefix,
          scopes_json: JSON.stringify(scopes),
          rotated_at: rotatedAt,
          updated_at: rotatedAt,
        })
        .where(eq(internal_services.id, service.id));

      return c.json({
        internalService: {
          id: service.id,
          name: service.name,
          scopes,
          status: "active",
          rotatedAt,
          updatedAt: rotatedAt,
          secret,
        },
      });
    },
  );

  app.post(
    INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH,
    createServiceAuth({
      requiredScopes: ["identity.read"],
    }),
    async (c) => {
      let payload: unknown;
      try {
        payload = await c.req.json();
      } catch {
        throw new AppError({
          code: "AGENT_OWNERSHIP_INVALID",
          message: "Ownership payload is invalid",
          status: 400,
          expose: true,
        });
      }

      const parsed = parseInternalOwnershipCheckPayload(payload);
      const db = createDb(c.env.DB);

      const rows = await db
        .select({
          ownerDid: humans.did,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(humans, eq(agents.owner_id, humans.id))
        .where(eq(agents.did, parsed.agentDid))
        .limit(1);

      const row = rows[0];
      return c.json({
        ownsAgent: row !== undefined && row.ownerDid === parsed.ownerDid,
        agentStatus: row?.status ?? null,
      });
    },
  );
}
