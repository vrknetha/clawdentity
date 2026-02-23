import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { afterEach, beforeEach, vi } from "vitest";
import { resetClawdentityEnv } from "../../test-env.js";
import { createPairCommand } from "../pair.js";

const previousEnv = process.env;

type FsPromises = typeof import("node:fs/promises");

export type PairFixture = {
  ait: string;
  secretKeyBase64url: string;
};

export const INITIATOR_PROFILE = {
  agentName: "alpha",
  humanName: "Ravi",
};

export const RESPONDER_PROFILE = {
  agentName: "beta",
  humanName: "Ira",
};

export const PAIR_CONFIG_DIR = "/tmp/.clawdentity";

export const asFetch = (impl: unknown): typeof fetch => impl as typeof fetch;

export const asReadFile = (impl: unknown): FsPromises["readFile"] =>
  impl as FsPromises["readFile"];

export const asWriteFile = (impl: unknown): FsPromises["writeFile"] =>
  impl as FsPromises["writeFile"];

export const asMkdir = (impl: unknown): FsPromises["mkdir"] =>
  impl as FsPromises["mkdir"];

export const asReaddir = (impl: unknown): FsPromises["readdir"] =>
  impl as FsPromises["readdir"];

export const asUnlink = (impl: unknown): FsPromises["unlink"] =>
  impl as FsPromises["unlink"];

export const asChmod = (impl: unknown): FsPromises["chmod"] =>
  impl as FsPromises["chmod"];

export const setupPairTestEnv = () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = resetClawdentityEnv(previousEnv);
  });

  afterEach(() => {
    process.env = previousEnv;
  });
};

export const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

export const createPairFixture = async (): Promise<PairFixture> => {
  const keypair = await generateEd25519Keypair();
  const encoded = encodeEd25519KeypairBase64url(keypair);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))
    .toString("base64url")
    .trim();
  const payload = Buffer.from(
    JSON.stringify({
      sub: "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
    }),
  )
    .toString("base64url")
    .trim();

  return {
    ait: `${header}.${payload}.sig`,
    secretKeyBase64url: encoded.secretKey,
  };
};

export const createPairTicket = (
  issuer = "https://alpha.proxy.example",
): string =>
  `clwpair1_${Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url")}`;

export const createReadFileMock = (fixture: PairFixture) => {
  return vi.fn(async (filePath: string, encoding?: BufferEncoding) => {
    if (filePath.endsWith("/ait.jwt")) {
      return fixture.ait;
    }

    if (filePath.endsWith("/secret.key")) {
      return fixture.secretKeyBase64url;
    }

    if (filePath.endsWith("pair.png")) {
      if (encoding) {
        return "";
      }
      return new Uint8Array([1, 2, 3, 4]);
    }

    throw buildErrnoError("ENOENT");
  });
};

export const runPairCommand = async (
  args: string[],
  command = createPairCommand(),
): Promise<{
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
}> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });

  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });

  process.exitCode = undefined;

  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "pair", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
};
