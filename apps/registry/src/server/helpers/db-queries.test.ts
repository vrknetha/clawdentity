import { AppError } from "@clawdentity/sdk";
import { describe, expect, it } from "vitest";
import { getMutationRowCount } from "./db-queries.js";

describe("getMutationRowCount", () => {
  it("returns the row count from the d1 meta.changes field", () => {
    expect(
      getMutationRowCount({
        result: {
          meta: {
            changes: 1,
          },
        },
        operation: "test.mutation",
      }),
    ).toBe(1);
  });

  it("returns zero when the d1 mutation updates zero rows", () => {
    expect(
      getMutationRowCount({
        result: {
          meta: {
            changes: 0,
          },
        },
        operation: "test.noop",
      }),
    ).toBe(0);
  });

  it.each([
    {
      label: "legacy changes shape",
      result: {
        changes: 1,
      },
    },
    {
      label: "legacy rowsAffected shape",
      result: {
        rowsAffected: 1,
      },
    },
    {
      label: "unknown object shape",
      result: {},
    },
    {
      label: "null result",
      result: null,
    },
    {
      label: "non-object result",
      result: 42,
    },
  ])("throws for unsupported mutation result shape: $label", ({ result }) => {
    try {
      getMutationRowCount({
        result,
        operation: "test.invalid",
      });
      throw new Error("Expected getMutationRowCount to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("DB_MUTATION_RESULT_INVALID");
      expect((error as AppError).status).toBe(500);
    }
  });
});
