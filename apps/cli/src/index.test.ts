import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CLI_VERSION, createProgram } from "./index.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

describe("cli", () => {
  it("exports CLI_VERSION", () => {
    expect(CLI_VERSION).toBe(packageJson.version);
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

  it("registers the admin command", () => {
    const hasAdminCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("admin");

    expect(hasAdminCommand).toBe(true);
  });

  it("registers the verify command", () => {
    const hasVerifyCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("verify");

    expect(hasVerifyCommand).toBe(true);
  });

  it("registers the api-key command", () => {
    const hasApiKeyCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("api-key");

    expect(hasApiKeyCommand).toBe(true);
  });

  it("registers the connector command", () => {
    const hasConnectorCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("connector");

    expect(hasConnectorCommand).toBe(true);
  });

  it("registers the openclaw command", () => {
    const hasOpenclawCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("openclaw");

    expect(hasOpenclawCommand).toBe(true);
  });

  it("registers the pair command", () => {
    const hasPairCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("pair");

    expect(hasPairCommand).toBe(true);
  });

  it("registers the invite command", () => {
    const hasInviteCommand = createProgram()
      .commands.map((command) => command.name())
      .includes("invite");

    expect(hasInviteCommand).toBe(true);
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

    expect(output.join("")).toContain(packageJson.version);
  });
});
