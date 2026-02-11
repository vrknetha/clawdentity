import { describe, expect, it } from "vitest";
import {
  AppError,
  addSeconds,
  parseRegistryConfig,
  REQUEST_ID_HEADER,
  resolveRequestId,
  SDK_VERSION,
} from "./index.js";

describe("sdk", () => {
  it("exports SDK_VERSION", () => {
    expect(SDK_VERSION).toBe("0.0.0");
  });

  it("exports shared helpers", () => {
    expect(addSeconds("2026-01-01T00:00:00.000Z", 10)).toBe(
      "2026-01-01T00:00:10.000Z",
    );
    expect(resolveRequestId("valid-id-123")).toBe("valid-id-123");
    expect(parseRegistryConfig({ ENVIRONMENT: "test" }).ENVIRONMENT).toBe(
      "test",
    );
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
    expect(AppError).toBeTypeOf("function");
  });
});
