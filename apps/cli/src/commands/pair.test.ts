import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmPairing, createPairCommand, startPairing } from "./pair.js";

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

type PairFixture = {
  ait: string;
  secretKeyBase64url: string;
};

const createPairFixture = async (): Promise<PairFixture> => {
  const keypair = await generateEd25519Keypair();
  const encoded = encodeEd25519KeypairBase64url(keypair);

  return {
    ait: "ey.mock.ait",
    secretKeyBase64url: encoded.secretKey,
  };
};

const createReadFileMock = (fixture: PairFixture) => {
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

const previousEnv = process.env;

describe("pair command helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...previousEnv };
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it("starts pairing with local agent proof and configured owner PAT", async () => {
    const fixture = await createPairFixture();
    const readFileImpl = createReadFileMock(fixture);
    const readdirImpl = vi.fn(async () => [
      "alpha-pair-1699999000.png",
      "alpha-pair-1699999500.png",
      "notes.txt",
    ]);
    const unlinkImpl = vi.fn(async () => undefined);
    const writeFileImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      return Response.json(
        {
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          ticket: "clwpair1_eyJ2IjoxfQ",
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });

    const result = await startPairing(
      "alpha",
      {
        proxyUrl: "https://alpha.proxy.example",
        ttlSeconds: "900",
        qr: true,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl:
          readFileImpl as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        readdirImpl:
          readdirImpl as unknown as typeof import("node:fs/promises").readdir,
        unlinkImpl:
          unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
        qrEncodeImpl: async () => new Uint8Array([1, 2, 3]),
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.api.clawdentity.com/",
          apiKey: "clw_pat_configured",
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.ticket).toBe("clwpair1_eyJ2IjoxfQ");
    expect(result.proxyUrl).toBe("https://alpha.proxy.example/");
    expect(result.qrPath).toContain(
      "/tmp/.clawdentity/pairing/alpha-pair-1700000000.png",
    );
    expect(readdirImpl).toHaveBeenCalledTimes(1);
    expect(unlinkImpl).toHaveBeenCalledTimes(1);
    expect(unlinkImpl).toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/alpha-pair-1699999000.png",
    );
    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    expect(mkdirImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Claw ${fixture.ait}`);
    expect(headers.get("x-claw-owner-pat")).toBe("clw_pat_configured");
    expect(headers.get("x-claw-proof")).toBeTruthy();
    expect(headers.get("x-claw-body-sha256")).toBeTruthy();
    expect(headers.get("x-claw-timestamp")).toBe("1700000000");
    expect(headers.get("x-claw-nonce")).toBe("nonce-start");
    expect(String(init?.body ?? "")).toContain("ttlSeconds");
  });

  it("uses CLAWDENTITY_PROXY_URL when --proxy-url is omitted", async () => {
    process.env.CLAWDENTITY_PROXY_URL = "https://env.proxy.example";
    const fixture = await createPairFixture();

    const result = await startPairing(
      "alpha",
      {
        ownerPat: "clw_pat_explicit",
      },
      {
        fetchImpl: (async () =>
          Response.json(
            {
              initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
              ticket: "clwpair1_eyJ2IjoxfQ",
              expiresAt: "2026-02-18T00:00:00.000Z",
            },
            { status: 200 },
          )) as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.api.clawdentity.com/",
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.proxyUrl).toBe("https://env.proxy.example/");
  });

  it("fails start when owner PAT is missing", async () => {
    const fixture = await createPairFixture();

    await expect(
      startPairing(
        "alpha",
        {
          proxyUrl: "https://alpha.proxy.example",
        },
        {
          readFileImpl: createReadFileMock(
            fixture,
          ) as unknown as typeof import("node:fs/promises").readFile,
          resolveConfigImpl: async () => ({
            registryUrl: "https://dev.api.clawdentity.com/",
          }),
          getConfigDirImpl: () => "/tmp/.clawdentity",
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Owner PAT is required"),
    });
  });

  it("confirms pairing with qr-file ticket decode", async () => {
    const fixture = await createPairFixture();
    const unlinkImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      return Response.json(
        {
          paired: true,
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
        },
        { status: 201 },
      );
    });

    const result = await confirmPairing(
      "beta",
      {
        proxyUrl: "https://beta.proxy.example",
        qrFile: "/tmp/pair.png",
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        unlinkImpl:
          unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
        qrDecodeImpl: () => "clwpair1_ticket",
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.paired).toBe(true);
    expect(result.proxyUrl).toBe("https://beta.proxy.example/");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Claw ${fixture.ait}`);
    expect(headers.get("x-claw-proof")).toBeTruthy();
    expect(headers.get("x-claw-body-sha256")).toBeTruthy();
    expect(headers.get("x-claw-owner-pat")).toBeNull();
    expect(headers.get("x-claw-timestamp")).toBe("1700000000");
    expect(headers.get("x-claw-nonce")).toBe("nonce-confirm");
    expect(String(init?.body ?? "")).toContain("clwpair1_ticket");
    expect(unlinkImpl).toHaveBeenCalledTimes(1);
    expect(unlinkImpl).toHaveBeenCalledWith("/tmp/pair.png");
  });
});

const runPairCommand = async (
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

describe("pair command output", () => {
  it("prints pairing ticket from pair start", async () => {
    const fixture = await createPairFixture();
    const command = createPairCommand({
      fetchImpl: (async () =>
        Response.json(
          {
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            ticket: "clwpair1_eyJ2IjoxfQ",
            expiresAt: "2026-02-18T00:00:00.000Z",
          },
          { status: 200 },
        )) as unknown as typeof fetch,
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-start",
      qrEncodeImpl: async () => new Uint8Array([1, 2, 3]),
      readFileImpl: createReadFileMock(
        fixture,
      ) as unknown as typeof import("node:fs/promises").readFile,
      writeFileImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").writeFile,
      mkdirImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").mkdir,
      resolveConfigImpl: async () => ({
        registryUrl: "https://dev.api.clawdentity.com/",
        apiKey: "clw_pat_configured",
      }),
      getConfigDirImpl: () => "/tmp/.clawdentity",
    });

    const result = await runPairCommand(
      ["start", "alpha", "--proxy-url", "https://alpha.proxy.example", "--qr"],
      command,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Pairing ticket created");
    expect(result.stdout).toContain("Ticket: clwpair1_eyJ2IjoxfQ");
    expect(result.stdout).toContain("QR File: ");
  });
});
