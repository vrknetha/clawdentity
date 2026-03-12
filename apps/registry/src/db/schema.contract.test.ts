import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migrationSql from "../../drizzle/0000_common_marrow.sql?raw";
import authMigrationSql from "../../drizzle/0002_agent_auth_refresh.sql?raw";
import {
  agent_auth_events,
  agent_auth_sessions,
  agents,
  api_keys,
  humans,
  revocations,
} from "./schema.js";

const t10RequiredTables = [
  "humans",
  "agents",
  "revocations",
  "api_keys",
  "agent_auth_sessions",
  "agent_auth_events",
] as const;
describe("T10 schema contract", () => {
  it("defines required table names in schema source", () => {
    expect(getTableName(humans)).toBe("humans");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(revocations)).toBe("revocations");
    expect(getTableName(api_keys)).toBe("api_keys");
    expect(getTableName(agent_auth_sessions)).toBe("agent_auth_sessions");
    expect(getTableName(agent_auth_events)).toBe("agent_auth_events");
  });

  it("contains required tables in baseline migration SQL", () => {
    for (const tableName of t10RequiredTables) {
      expect(`${migrationSql}\n${authMigrationSql}`).toMatch(
        new RegExp(String.raw`CREATE TABLE \`${tableName}\``),
      );
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
});
