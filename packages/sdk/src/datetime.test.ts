import { describe, expect, it, vi } from "vitest";
import { addSeconds, isExpired, nowUtcMs, toIso } from "./datetime.js";

describe("datetime helpers", () => {
  it("returns epoch milliseconds for the current instant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      expect(nowUtcMs()).toBe(1767225600000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats valid datetime values as ISO-8601 UTC", () => {
    expect(toIso("2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(toIso(1767225600000)).toBe("2026-01-01T00:00:00.000Z");
  });

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
