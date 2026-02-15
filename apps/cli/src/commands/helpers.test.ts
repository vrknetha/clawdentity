import { afterEach, describe, expect, it, vi } from "vitest";

const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

vi.mock("@clawdentity/sdk", () => ({
  createLogger: vi.fn(() => ({
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  })),
}));

import { withErrorHandling } from "./helpers.js";

describe("withErrorHandling", () => {
  afterEach(() => {
    process.exitCode = undefined;
    mockLoggerError.mockReset();
    vi.restoreAllMocks();
  });

  it("catches command errors, sets exit code, and writes to stderr", async () => {
    const stderr: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });

    const wrapped = withErrorHandling("agent create", async () => {
      throw new Error("command failed");
    });

    await wrapped();

    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("command failed");
    expect(mockLoggerError).toHaveBeenCalledWith("cli.command_failed", {
      command: "agent create",
      errorMessage: "command failed",
    });
  });

  it("passes through successful command execution", async () => {
    const handler = vi.fn(async (name: string) => {});
    const wrapped = withErrorHandling("agent create", handler);

    await wrapped("agent-01");

    expect(process.exitCode).toBeUndefined();
    expect(handler).toHaveBeenCalledWith("agent-01");
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
