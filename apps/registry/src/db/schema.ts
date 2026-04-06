import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const humans = sqliteTable("humans", {
  id: text("id").primaryKey(),
  did: text("did").notNull().unique(),
  display_name: text("display_name").notNull(),
  role: text("role", { enum: ["admin", "user"] })
    .notNull()
    .default("user"),
  status: text("status", { enum: ["active", "suspended"] })
    .notNull()
    .default("active"),
  onboarding_source: text("onboarding_source"),
  agent_limit: integer("agent_limit"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    did: text("did").notNull().unique(),
    owner_id: text("owner_id")
      .notNull()
      .references(() => humans.id),
    name: text("name").notNull(),
    framework: text("framework"),
    public_key: text("public_key").notNull(),
    current_jti: text("current_jti"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    expires_at: text("expires_at"),
    gateway_hint: text("gateway_hint"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_agents_owner_status").on(table.owner_id, table.status),
  ],
);

export const revocations = sqliteTable(
  "revocations",
  {
    id: text("id").primaryKey(),
    jti: text("jti").notNull().unique(),
    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),
    reason: text("reason"),
    revoked_at: text("revoked_at").notNull(),
  },
  (table) => [index("idx_revocations_agent_id").on(table.agent_id)],
);

export const api_keys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    human_id: text("human_id")
      .notNull()
      .references(() => humans.id),
    key_hash: text("key_hash").notNull(),
    key_prefix: text("key_prefix").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
  },
  (table) => [index("idx_api_keys_key_hash").on(table.key_hash)],
);

export const agent_registration_challenges = sqliteTable(
  "agent_registration_challenges",
  {
    id: text("id").primaryKey(),
    owner_id: text("owner_id")
      .notNull()
      .references(() => humans.id),
    public_key: text("public_key").notNull(),
    nonce: text("nonce").notNull(),
    status: text("status", { enum: ["pending", "used"] })
      .notNull()
      .default("pending"),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_agent_registration_challenges_owner_status").on(
      table.owner_id,
      table.status,
    ),
    index("idx_agent_registration_challenges_expires_at").on(table.expires_at),
  ],
);

export const agent_auth_sessions = sqliteTable(
  "agent_auth_sessions",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),
    refresh_key_hash: text("refresh_key_hash").notNull(),
    refresh_key_prefix: text("refresh_key_prefix").notNull(),
    refresh_issued_at: text("refresh_issued_at").notNull(),
    refresh_expires_at: text("refresh_expires_at").notNull(),
    refresh_last_used_at: text("refresh_last_used_at"),
    access_key_hash: text("access_key_hash").notNull(),
    access_key_prefix: text("access_key_prefix").notNull(),
    access_issued_at: text("access_issued_at").notNull(),
    access_expires_at: text("access_expires_at").notNull(),
    access_last_used_at: text("access_last_used_at"),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    revoked_at: text("revoked_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_auth_sessions_agent_id_unique").on(table.agent_id),
    index("idx_agent_auth_sessions_agent_status").on(
      table.agent_id,
      table.status,
    ),
    index("idx_agent_auth_sessions_refresh_prefix").on(
      table.refresh_key_prefix,
    ),
    index("idx_agent_auth_sessions_access_prefix").on(table.access_key_prefix),
  ],
);

export const agent_auth_events = sqliteTable(
  "agent_auth_events",
  {
    id: text("id").primaryKey(),
    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),
    session_id: text("session_id")
      .notNull()
      .references(() => agent_auth_sessions.id),
    event_type: text("event_type", {
      enum: ["issued", "refreshed", "revoked", "refresh_rejected"],
    }).notNull(),
    reason: text("reason"),
    metadata_json: text("metadata_json"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_agent_auth_events_agent_created").on(
      table.agent_id,
      table.created_at,
    ),
    index("idx_agent_auth_events_session_created").on(
      table.session_id,
      table.created_at,
    ),
  ],
);

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  created_by: text("created_by")
    .notNull()
    .references(() => humans.id),
  redeemed_by: text("redeemed_by").references(() => humans.id),
  agent_id: text("agent_id").references(() => agents.id),
  expires_at: text("expires_at"),
  created_at: text("created_at").notNull(),
});

export const starter_passes = sqliteTable(
  "starter_passes",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull().unique(),
    provider: text("provider", { enum: ["github"] }).notNull(),
    provider_subject: text("provider_subject").notNull(),
    provider_login: text("provider_login").notNull(),
    display_name: text("display_name").notNull(),
    redeemed_by: text("redeemed_by").references(() => humans.id),
    issued_at: text("issued_at").notNull(),
    redeemed_at: text("redeemed_at"),
    expires_at: text("expires_at").notNull(),
    status: text("status", { enum: ["active", "redeemed", "expired"] })
      .notNull()
      .default("active"),
  },
  (table) => [
    uniqueIndex("starter_passes_provider_subject_unique").on(
      table.provider,
      table.provider_subject,
    ),
    index("idx_starter_passes_code_status").on(table.code, table.status),
  ],
);

export const internal_services = sqliteTable(
  "internal_services",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    secret_hash: text("secret_hash").notNull(),
    secret_prefix: text("secret_prefix").notNull(),
    scopes_json: text("scopes_json").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    created_by: text("created_by")
      .notNull()
      .references(() => humans.id),
    rotated_at: text("rotated_at"),
    last_used_at: text("last_used_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_internal_services_secret_prefix").on(table.secret_prefix),
    index("idx_internal_services_status").on(table.status),
  ],
);

export const groups = sqliteTable(
  "groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    created_by: text("created_by")
      .notNull()
      .references(() => humans.id),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [index("idx_groups_created_by").on(table.created_by)],
);

export const group_members = sqliteTable(
  "group_members",
  {
    group_id: text("group_id")
      .notNull()
      .references(() => groups.id),
    agent_id: text("agent_id")
      .notNull()
      .references(() => agents.id),
    role: text("role", { enum: ["member", "admin"] })
      .notNull()
      .default("member"),
    joined_at: text("joined_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.group_id, table.agent_id] }),
    index("idx_group_members_group").on(table.group_id),
    index("idx_group_members_agent").on(table.agent_id),
  ],
);

export const group_join_tokens = sqliteTable(
  "group_join_tokens",
  {
    id: text("id").primaryKey(),
    group_id: text("group_id")
      .notNull()
      .references(() => groups.id),
    token_hash: text("token_hash").notNull(),
    token_prefix: text("token_prefix").notNull(),
    token_ciphertext: text("token_ciphertext").notNull(),
    role: text("role", { enum: ["member", "admin"] })
      .notNull()
      .default("member"),
    revoked_at: text("revoked_at"),
    issued_by: text("issued_by")
      .notNull()
      .references(() => humans.id),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("group_join_tokens_token_hash_unique").on(table.token_hash),
    index("idx_group_join_tokens_prefix").on(table.token_prefix),
    index("idx_group_join_tokens_group").on(table.group_id),
    index("idx_group_join_tokens_revoked").on(table.revoked_at),
  ],
);
