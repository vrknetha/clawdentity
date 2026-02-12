import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import migrationSql from "../../drizzle/0000_common_marrow.sql?raw";
import { agents, api_keys, humans, revocations } from "./schema.js";

const t10RequiredTables = [
  "humans",
  "agents",
  "revocations",
  "api_keys",
] as const;
describe("T10 schema contract", () => {
  it("defines required table names in schema source", () => {
    expect(getTableName(humans)).toBe("humans");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(revocations)).toBe("revocations");
    expect(getTableName(api_keys)).toBe("api_keys");
  });

  it("contains required tables in baseline migration SQL", () => {
    for (const tableName of t10RequiredTables) {
      expect(migrationSql).toMatch(
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
});
