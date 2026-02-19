import { encodeBase64url } from "@clawdentity/protocol";
import {
  AppError,
  INTERNAL_SERVICE_ID_HEADER,
  INTERNAL_SERVICE_SECRET_HEADER,
} from "@clawdentity/sdk";
import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createDb } from "../db/client.js";
import { internal_services } from "../db/schema.js";
import { constantTimeEqual } from "./api-key-token.js";
import { parseInternalServiceScopesJson } from "./internal-service-scopes.js";

export const INTERNAL_SERVICE_SECRET_MARKER = "clw_srv_";
const INTERNAL_SERVICE_SECRET_LOOKUP_ENTROPY_LENGTH = 8;
const INTERNAL_SERVICE_SECRET_RANDOM_BYTES_LENGTH = 32;

export type AuthenticatedService = {
  id: string;
  name: string;
  scopes: string[];
};

function unauthorizedError(message: string): AppError {
  return new AppError({
    code: "INTERNAL_SERVICE_UNAUTHORIZED",
    message,
    status: 401,
    expose: true,
  });
}

function forbiddenError(message: string): AppError {
  return new AppError({
    code: "INTERNAL_SERVICE_FORBIDDEN",
    message,
    status: 403,
    expose: true,
  });
}

function parseRequiredHeader(value: string | undefined, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw unauthorizedError(`${label} header is required`);
  }

  return normalized;
}

function parseServiceSecret(secret: string): string {
  if (
    !secret.startsWith(INTERNAL_SERVICE_SECRET_MARKER) ||
    secret.length <= INTERNAL_SERVICE_SECRET_MARKER.length
  ) {
    throw unauthorizedError("Service secret is invalid");
  }

  return secret;
}

export function deriveInternalServiceSecretPrefix(secret: string): string {
  const normalized = parseServiceSecret(secret);
  const entropyPrefix = normalized.slice(
    INTERNAL_SERVICE_SECRET_MARKER.length,
    INTERNAL_SERVICE_SECRET_MARKER.length +
      INTERNAL_SERVICE_SECRET_LOOKUP_ENTROPY_LENGTH,
  );
  if (entropyPrefix.length === 0) {
    throw unauthorizedError("Service secret is invalid");
  }

  return `${INTERNAL_SERVICE_SECRET_MARKER}${entropyPrefix}`;
}

export async function hashInternalServiceSecret(
  secret: string,
): Promise<string> {
  const normalized = parseServiceSecret(secret);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function generateInternalServiceSecret(): string {
  const randomBytes = crypto.getRandomValues(
    new Uint8Array(INTERNAL_SERVICE_SECRET_RANDOM_BYTES_LENGTH),
  );
  return `${INTERNAL_SERVICE_SECRET_MARKER}${encodeBase64url(randomBytes)}`;
}

function assertScopes(
  availableScopes: readonly string[],
  requiredScopes: readonly string[],
): void {
  if (requiredScopes.length === 0) {
    return;
  }

  const available = new Set(availableScopes);
  for (const requiredScope of requiredScopes) {
    if (!available.has(requiredScope)) {
      throw forbiddenError("Internal service is missing required scope");
    }
  }
}

export function createServiceAuth(options?: {
  requiredScopes?: readonly string[];
}) {
  const requiredScopes = [...(options?.requiredScopes ?? [])];
  return createMiddleware<{
    Bindings: {
      DB: D1Database;
    };
    Variables: {
      service: AuthenticatedService;
    };
  }>(async (c, next) => {
    const serviceId = parseRequiredHeader(
      c.req.header(INTERNAL_SERVICE_ID_HEADER),
      INTERNAL_SERVICE_ID_HEADER,
    );
    const serviceSecret = parseRequiredHeader(
      c.req.header(INTERNAL_SERVICE_SECRET_HEADER),
      INTERNAL_SERVICE_SECRET_HEADER,
    );
    const secretPrefix = deriveInternalServiceSecretPrefix(serviceSecret);
    const secretHash = await hashInternalServiceSecret(serviceSecret);

    const db = createDb(c.env.DB);
    const rows = await db
      .select({
        id: internal_services.id,
        name: internal_services.name,
        secretHash: internal_services.secret_hash,
        scopesJson: internal_services.scopes_json,
      })
      .from(internal_services)
      .where(
        and(
          eq(internal_services.id, serviceId),
          eq(internal_services.secret_prefix, secretPrefix),
          eq(internal_services.status, "active"),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row || !constantTimeEqual(secretHash, row.secretHash)) {
      throw unauthorizedError("Service credentials are invalid");
    }

    const scopes = parseInternalServiceScopesJson(row.scopesJson);
    assertScopes(scopes, requiredScopes);

    c.set("service", {
      id: row.id,
      name: row.name,
      scopes,
    });

    await db
      .update(internal_services)
      .set({
        last_used_at: new Date().toISOString(),
      })
      .where(eq(internal_services.id, row.id));

    await next();
  });
}
