import {
  createLogger,
  type EventBus,
  type QueuePublisher,
  type RegistryConfig,
} from "@clawdentity/sdk";
import type { Hono } from "hono";
import type { AuthenticatedHuman } from "../auth/api-key-auth.js";
import type { AuthenticatedService } from "../auth/service-auth.js";

export type Bindings = {
  DB: D1Database;
  ENVIRONMENT: string;
  APP_VERSION?: string;
  PROXY_URL?: string;
  REGISTRY_ISSUER_URL?: string;
  LANDING_URL?: string;
  EVENT_BUS_BACKEND?: "memory" | "queue";
  EVENT_BUS_QUEUE?: QueuePublisher;
  BOOTSTRAP_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_OAUTH_STATE_SECRET?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_SIGNING_KEYS?: string;
};

export type RegistryRateLimitRuntimeOptions = {
  nowMs?: () => number;
  resolveMaxRequests?: number;
  resolveWindowMs?: number;
  crlMaxRequests?: number;
  crlWindowMs?: number;
  agentAuthRefreshMaxRequests?: number;
  agentAuthRefreshWindowMs?: number;
  agentAuthValidateMaxRequests?: number;
  agentAuthValidateWindowMs?: number;
};

export type CreateRegistryAppOptions = {
  rateLimit?: RegistryRateLimitRuntimeOptions;
  eventBus?: EventBus;
};

export type RegistryApp = Hono<{
  Bindings: Bindings;
  Variables: {
    requestId: string;
    human: AuthenticatedHuman;
    service: AuthenticatedService;
  };
}>;

export type RegistryRouteDependencies = {
  app: RegistryApp;
  getConfig: (bindings: Bindings) => RegistryConfig;
  getEventBus: (bindings: Bindings) => EventBus;
};

export type OwnedAgent = {
  id: string;
  did: string;
  name: string;
  framework: string | null;
  public_key: string;
  status: "active" | "revoked";
  expires_at: string | null;
  current_jti: string | null;
};

export type OwnedAgentRegistrationChallenge = {
  id: string;
  owner_id: string;
  public_key: string;
  nonce: string;
  status: "pending" | "used";
  expires_at: string;
  used_at: string | null;
};

export type OwnedAgentAuthSession = {
  id: string;
  agent_id: string;
  refresh_key_hash: string;
  refresh_key_prefix: string;
  refresh_issued_at: string;
  refresh_expires_at: string;
  refresh_last_used_at: string | null;
  access_key_hash: string;
  access_key_prefix: string;
  access_issued_at: string;
  access_expires_at: string;
  access_last_used_at: string | null;
  status: "active" | "revoked";
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type InviteRow = {
  id: string;
  code: string;
  created_by: string;
  redeemed_by: string | null;
  agent_id: string | null;
  expires_at: string | null;
  created_at: string;
};

export type StarterPassRow = {
  id: string;
  code: string;
  provider: "github";
  provider_subject: string;
  provider_login: string;
  display_name: string;
  redeemed_by: string | null;
  issued_at: string;
  redeemed_at: string | null;
  expires_at: string;
  status: "active" | "redeemed" | "expired";
};

export type CrlSnapshotRow = {
  id: string;
  jti: string;
  reason: string | null;
  revoked_at: string;
  agent_did: string;
};

export const logger = createLogger({ service: "registry" });
export const REGISTRY_CACHE_MAX_AGE_SECONDS = 300;
export const REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 60;
export const REGISTRY_KEY_CACHE_CONTROL = `public, max-age=${REGISTRY_CACHE_MAX_AGE_SECONDS}, s-maxage=${REGISTRY_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS}`;
export const REGISTRY_CRL_CACHE_CONTROL = `public, max-age=${REGISTRY_CACHE_MAX_AGE_SECONDS}, s-maxage=${REGISTRY_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=${REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS}`;

const CRL_EXPIRY_SAFETY_BUFFER_SECONDS = 30;
export const CRL_TTL_SECONDS =
  REGISTRY_CACHE_MAX_AGE_SECONDS +
  REGISTRY_CACHE_STALE_WHILE_REVALIDATE_SECONDS +
  CRL_EXPIRY_SAFETY_BUFFER_SECONDS;

export const PROXY_URL_BY_ENVIRONMENT: Record<
  RegistryConfig["ENVIRONMENT"],
  string
> = {
  local: "https://dev.proxy.clawdentity.com",
  development: "https://dev.proxy.clawdentity.com",
  production: "https://proxy.clawdentity.com",
};

export const LANDING_URL_BY_ENVIRONMENT: Record<
  RegistryConfig["ENVIRONMENT"],
  string
> = {
  local: "https://clawdentity-site-dev.pages.dev",
  development: "https://clawdentity-site-dev.pages.dev",
  production: "https://clawdentity.com",
};

// Deterministic bootstrap identity guarantees one-time admin creation under races.
export const BOOTSTRAP_ADMIN_HUMAN_ID = "00000000000000000000000000";
export const REGISTRY_SERVICE_EVENT_VERSION = "v1";

export const AGENT_AUTH_EVENT_NAME_BY_TYPE: Record<
  "issued" | "refreshed" | "revoked" | "refresh_rejected",
  string
> = {
  issued: "agent.auth.issued",
  refreshed: "agent.auth.refreshed",
  revoked: "agent.auth.revoked",
  refresh_rejected: "agent.auth.refresh_rejected",
};
