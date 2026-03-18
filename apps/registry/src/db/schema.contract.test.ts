import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migrationSql from "../../drizzle/0000_common_marrow.sql?raw";
import authMigrationSql from "../../drizzle/0002_agent_auth_refresh.sql?raw";
import starterPassMigrationSql from "../../drizzle/0005_github_starter_passes.sql?raw";
import {
  agent_auth_events,
  agent_auth_sessions,
  agents,
  api_keys,
  humans,
  revocations,
  starter_passes,
} from "./schema.js";

const t10RequiredTables = [
  "humans",
  "agents",
  "revocations",
  "api_keys",
  "agent_auth_sessions",
  "agent_auth_events",
  "starter_passes",
] as const;
describe("T10 schema contract", () => {
  it("defines required table names in schema source", () => {
    expect(getTableName(humans)).toBe("humans");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(revocations)).toBe("revocations");
    expect(getTableName(api_keys)).toBe("api_keys");
    expect(getTableName(agent_auth_sessions)).toBe("agent_auth_sessions");
    expect(getTableName(agent_auth_events)).toBe("agent_auth_events");
    expect(getTableName(starter_passes)).toBe("starter_passes");
  });

  it("contains required tables in baseline migration SQL", () => {
    for (const tableName of t10RequiredTables) {
      expect(
        `${migrationSql}\n${authMigrationSql}\n${starterPassMigrationSql}`,
      ).toMatch(new RegExp(String.raw`CREATE TABLE \`${tableName}\``));
    }
  });

  it("creates the required owner/status index for agents", () => {
    expect(migrationSql).toMatch(
      /CREATE INDEX `idx_agents_owner_status` ON `agents` \(`owner_id`,`status`\);/,
    );
  });

  it("creates a revocations jti lookup index (unique or non-unique)", () => {
    expect(migrationSql).toMatch(
      /CREATE (?:UNIQUE )?INDEX `[^`]+` ON `revocations` \(`jti`\);/,
    );
  });

  it("creates required agent auth session indexes", () => {
    expect(authMigrationSql).toMatch(
      /CREATE UNIQUE INDEX `agent_auth_sessions_agent_id_unique` ON `agent_auth_sessions` \(`agent_id`\);/,
    );
    expect(authMigrationSql).toMatch(
      /CREATE INDEX `idx_agent_auth_sessions_refresh_prefix` ON `agent_auth_sessions` \(`refresh_key_prefix`\);/,
    );
  });

  it("adds human onboarding metadata columns and starter-pass indexes", () => {
    expect(starterPassMigrationSql).toMatch(
      /ALTER TABLE `humans` ADD `onboarding_source` text;/,
    );
    expect(starterPassMigrationSql).toMatch(
      /ALTER TABLE `humans` ADD `agent_limit` integer;/,
    );
    expect(starterPassMigrationSql).toMatch(
      /CREATE UNIQUE INDEX `starter_passes_provider_subject_unique` ON `starter_passes` \(`provider`,`provider_subject`\);/,
    );
    expect(starterPassMigrationSql).toMatch(
      /CREATE INDEX `idx_starter_passes_code_status` ON `starter_passes` \(`code`,`status`\);/,
    );
  });
});
