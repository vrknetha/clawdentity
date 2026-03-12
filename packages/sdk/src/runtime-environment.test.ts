import { describe, expect, it } from "vitest";
import {
  runtimeEnvironmentValues,
  shouldExposeVerboseErrors,
} from "./runtime-environment.js";

describe("runtime environment helpers", () => {
  it("declares the supported runtime environments", () => {
    expect(runtimeEnvironmentValues).toEqual([
      "local",
      "development",
      "production",
    ]);
  });

  it("exposes verbose errors for non-production environments", () => {
    expect(shouldExposeVerboseErrors("development")).toBe(true);
    expect(shouldExposeVerboseErrors("local")).toBe(true);
  });

  it("hides verbose errors in production", () => {
    expect(shouldExposeVerboseErrors("production")).toBe(false);
  });
});
