import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../config/manager.js", () => ({
  readCacheFile: vi.fn(),
  resolveConfig: vi.fn(),
  writeCacheFile: vi.fn(),
}));

vi.mock("@clawdentity/sdk", () => ({
  createLogger: vi.fn(() => ({
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  parseRegistryConfig: vi.fn(),
  verifyAIT: vi.fn(),
  verifyCRL: vi.fn(),
}));

import { parseRegistryConfig, verifyAIT, verifyCRL } from "@clawdentity/sdk";
import {
  readCacheFile,
  resolveConfig,
  writeCacheFile,
} from "../config/manager.js";
import { createVerifyCommand } from "./verify.js";

const mockedTokenReadFile = vi.mocked(readFile);
const mockedResolveConfig = vi.mocked(resolveConfig);
const mockedReadCacheFile = vi.mocked(readCacheFile);
const mockedWriteCacheFile = vi.mocked(writeCacheFile);
const mockedParseRegistryConfig = vi.mocked(parseRegistryConfig);
const mockedVerifyAit = vi.mocked(verifyAIT);
const mockedVerifyCrl = vi.mocked(verifyCRL);

const mockFetch = vi.fn<typeof fetch>();

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

const runVerifyCommand = async (args: string[]) => {
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

  const command = createVerifyCommand();
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "verify", ...args]);
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

const activeSigningKey = {
  kid: "reg-key-1",
  alg: "EdDSA",
  crv: "Ed25519",
  x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
  status: "active",
} as const;

const tokenClaims = {
  iss: "https://api.clawdentity.com",
  sub: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
  ownerDid: "did:claw:human:01HF7YAT00W6W7CM7N3W5FDXT5",
  name: "agent-01",
  framework: "openclaw",
  cnf: {
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
    },
  },
  iat: 1_700_000_000,
  nbf: 1_700_000_000,
  exp: 1_900_000_000,
  jti: "01HF7YAT5QJ4K3YVQJ6Q2F9M1N",
} as const;

const crlClaims = {
  iss: "https://api.clawdentity.com",
  jti: "01HF7YAT4TXP6AW5QNXA2Y9K43",
  iat: 1_700_000_000,
  exp: 1_900_000_000,
  revocations: [
    {
      jti: "01HF7YAT31JZHSMW1CG6Q6MHB7",
      agentDid: "did:claw:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      revokedAt: 1_700_000_100,
    },
  ],
};

describe("verify command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);

    mockedTokenReadFile.mockRejectedValue(buildErrnoError("ENOENT"));
    mockedResolveConfig.mockResolvedValue({
      registryUrl: "https://api.clawdentity.com",
    });
    mockedReadCacheFile.mockResolvedValue(undefined);
    mockedWriteCacheFile.mockResolvedValue(undefined);

    mockedParseRegistryConfig.mockReturnValue({
      ENVIRONMENT: "test",
      REGISTRY_SIGNING_KEYS: [activeSigningKey],
    });

    mockedVerifyAit.mockResolvedValue(tokenClaims);
    mockedVerifyCrl.mockResolvedValue(crlClaims);

    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        keys: [activeSigningKey],
      }),
    );
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        crl: "crl.jwt.value",
      }),
    );
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("verifies a valid token", async () => {
    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("✅ token verified");
    expect(result.exitCode).toBeUndefined();
    expect(mockedVerifyAit).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token.jwt",
      }),
    );
  });

  it("fails when token is revoked", async () => {
    mockedVerifyCrl.mockResolvedValueOnce({
      ...crlClaims,
      revocations: [
        {
          ...crlClaims.revocations[0],
          jti: tokenClaims.jti,
        },
      ],
    });

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("❌ revoked");
    expect(result.exitCode).toBe(1);
  });

  it("fails with reason when token signature is invalid", async () => {
    mockedVerifyAit.mockRejectedValueOnce(
      new Error("signature verification failed"),
    );

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("❌ invalid token");
    expect(result.exitCode).toBe(1);
  });

  it("fails when keyset cannot be fetched", async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("❌ verification keys unavailable");
    expect(result.exitCode).toBe(1);
  });

  it("fails when CRL cannot be fetched", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        keys: [activeSigningKey],
      }),
    );
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("❌ revocation check unavailable");
    expect(result.exitCode).toBe(1);
  });

  it("fails when fetched CRL cannot be verified", async () => {
    mockedVerifyCrl.mockRejectedValueOnce(new Error("invalid CRL token"));

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain(
      "❌ revocation check unavailable (invalid CRL)",
    );
    expect(result.exitCode).toBe(1);
  });

  it("supports reading token from file path", async () => {
    mockedTokenReadFile.mockResolvedValueOnce("file-token.jwt\n");

    const result = await runVerifyCommand(["./ait.jwt"]);

    expect(result.stdout).toContain("✅ token verified");
    expect(mockedVerifyAit).toHaveBeenCalledWith(
      expect.objectContaining({ token: "file-token.jwt" }),
    );
  });

  it("uses fresh disk caches and skips network fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T16:00:00.000Z"));

    mockedReadCacheFile.mockImplementation(async (fileName: string) => {
      if (fileName === "registry-keys.json") {
        return JSON.stringify({
          registryUrl: "https://api.clawdentity.com/",
          fetchedAtMs: Date.now() - 1_000,
          keys: [activeSigningKey],
        });
      }

      if (fileName === "crl-claims.json") {
        return JSON.stringify({
          registryUrl: "https://api.clawdentity.com/",
          fetchedAtMs: Date.now() - 1_000,
          claims: crlClaims,
        });
      }

      return undefined;
    });

    mockFetch.mockReset();

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("✅ token verified");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockedVerifyCrl).not.toHaveBeenCalled();
    expect(mockedWriteCacheFile).not.toHaveBeenCalled();
  });

  it("refreshes stale caches from the network", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T16:00:00.000Z"));

    mockedReadCacheFile.mockImplementation(async (fileName: string) => {
      if (fileName === "registry-keys.json") {
        return JSON.stringify({
          registryUrl: "https://api.clawdentity.com/",
          fetchedAtMs: Date.now() - 60 * 60 * 1000 - 1,
          keys: [activeSigningKey],
        });
      }

      if (fileName === "crl-claims.json") {
        return JSON.stringify({
          registryUrl: "https://api.clawdentity.com/",
          fetchedAtMs: Date.now() - 15 * 60 * 1000 - 1,
          claims: crlClaims,
        });
      }

      return undefined;
    });

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        keys: [activeSigningKey],
      }),
    );
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(200, {
        crl: "crl.jwt.value",
      }),
    );

    const result = await runVerifyCommand(["token.jwt"]);

    expect(result.stdout).toContain("✅ token verified");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockedWriteCacheFile).toHaveBeenCalledTimes(2);
  });
});
