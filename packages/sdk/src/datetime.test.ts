import { describe, expect, it } from "vitest";
import { addSeconds, isExpired } from "./datetime.js";

describe("datetime helpers", () => {
  it("adds seconds to a datetime", () => {
    expect(addSeconds("2026-01-01T00:00:00.000Z", 90)).toBe(
      "2026-01-01T00:01:30.000Z",
    );
  });

  it("evaluates expiry using UTC timestamps", () => {
    expect(
      isExpired("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    ).toBe(true);
    expect(
      isExpired("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:00.000Z"),
    ).toBe(false);
  });
});
