import { describe, expect, it } from "vitest";
import { CLI_VERSION, createProgram } from "./index.js";

describe("cli", () => {
  it("exports CLI_VERSION", () => {
    expect(CLI_VERSION).toBe("0.0.0");
  });

  it("creates a program named clawdentity", () => {
    expect(createProgram().name()).toBe("clawdentity");
  });

  it("registers the config command", () => {
    const hasConfigCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("config");

    expect(hasConfigCommand).toBe(true);
  });

  it("registers the agent command", () => {
    const hasAgentCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("agent");

    expect(hasAgentCommand).toBe(true);
  });

  it("registers the verify command", () => {
    const hasVerifyCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("verify");

    expect(hasVerifyCommand).toBe(true);
  });

  it("registers the openclaw command", () => {
    const hasOpenclawCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("openclaw");

    expect(hasOpenclawCommand).toBe(true);
  });

  it("prints version output", async () => {
    const output: string[] = [];
    const program = createProgram();

    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });

    await expect(
      program.parseAsync(["node", "clawdentity", "--version"]),
    ).rejects.toMatchObject({
      code: "commander.version",
      exitCode: 0,
    });

    expect(output.join("")).toContain("0.0.0");
  });
});
