import {
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClawdentityEnv } from "../test-env.js";
import {
  confirmPairing,
  createPairCommand,
  getPairingStatus,
  recoverPairing,
  startPairing,
} from "./pair.js";

const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

type PairFixture = {
  ait: string;
  secretKeyBase64url: string;
};

const INITIATOR_PROFILE = {
  agentName: "alpha",
  humanName: "Ravi",
};

const RESPONDER_PROFILE = {
  agentName: "beta",
  humanName: "Ira",
};

const createPairFixture = async (): Promise<PairFixture> => {
  const keypair = await generateEd25519Keypair();
  const encoded = encodeEd25519KeypairBase64url(keypair);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))
    .toString("base64url")
    .trim();
  const payload = Buffer.from(
    JSON.stringify({
      sub: "did:claw:agent:01HAAA11111111111111111111",
    }),
  )
    .toString("base64url")
    .trim();

  return {
    ait: `${header}.${payload}.sig`,
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
    process.env = resetClawdentityEnv(previousEnv);
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
    const writeFileImpl = vi.fn(
      async (
        _filePath: string,
        _data: string | Uint8Array,
        _encoding?: BufferEncoding,
      ) => undefined,
    );
    const mkdirImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      return Response.json(
        {
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          ticket: "clwpair1_eyJ2IjoxfQ",
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });

    const result = await startPairing(
      "alpha",
      {
        ttlSeconds: "900",
        allowResponder: "did:claw:agent:01HBBB22222222222222222222",
        callbackUrl: "https://callbacks.example.com/pairing",
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
          registryUrl: "https://dev.registry.clawdentity.com/",
          humanName: INITIATOR_PROFILE.humanName,
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
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Claw ${fixture.ait}`);
    expect(headers.get("x-claw-proof")).toBeTruthy();
    expect(headers.get("x-claw-body-sha256")).toBeTruthy();
    expect(headers.get("x-claw-timestamp")).toBe("1700000000");
    expect(headers.get("x-claw-nonce")).toBe("nonce-start");
    expect(String(init?.body ?? "")).toContain("ttlSeconds");
    expect(String(init?.body ?? "")).toContain("initiatorProfile");
    expect(String(init?.body ?? "")).toContain("allowResponderAgentDid");
    expect(String(init?.body ?? "")).toContain("callbackUrl");
  });

  it("uses CLAWDENTITY_PROXY_URL when no proxy override options are present", async () => {
    process.env.CLAWDENTITY_PROXY_URL = "https://env.proxy.example";
    const fixture = await createPairFixture();

    const result = await startPairing(
      "alpha",
      {},
      {
        fetchImpl: (async () =>
          Response.json(
            {
              initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
              initiatorProfile: INITIATOR_PROFILE,
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
          registryUrl: "https://dev.registry.clawdentity.com/",
          humanName: INITIATOR_PROFILE.humanName,
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.proxyUrl).toBe("https://env.proxy.example/");
  });

  it("uses registry metadata proxyUrl when env override is omitted", async () => {
    const fixture = await createPairFixture();

    const result = await startPairing(
      "alpha",
      {},
      {
        fetchImpl: (async (url: string) => {
          if (url.endsWith("/v1/metadata")) {
            return Response.json(
              {
                status: "ok",
                proxyUrl: "https://saved.proxy.example",
              },
              { status: 200 },
            );
          }

          return Response.json(
            {
              initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
              initiatorProfile: INITIATOR_PROFILE,
              ticket: "clwpair1_eyJ2IjoxfQ",
              expiresAt: "2026-02-18T00:00:00.000Z",
            },
            { status: 200 },
          );
        }) as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.registry.clawdentity.com/",
          proxyUrl: "https://saved.proxy.example",
          humanName: INITIATOR_PROFILE.humanName,
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.proxyUrl).toBe("https://saved.proxy.example/");
  });

  it("fails when configured proxyUrl does not match registry metadata", async () => {
    const fixture = await createPairFixture();

    await expect(
      startPairing(
        "alpha",
        {},
        {
          fetchImpl: (async (url: string) => {
            if (url.endsWith("/v1/metadata")) {
              return Response.json(
                {
                  status: "ok",
                  proxyUrl: "https://proxy.clawdentity.com",
                },
                { status: 200 },
              );
            }

            return Response.json(
              {
                initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
                initiatorProfile: INITIATOR_PROFILE,
                ticket: "clwpair1_eyJ2IjoxfQ",
                expiresAt: "2026-02-18T00:00:00.000Z",
              },
              { status: 200 },
            );
          }) as unknown as typeof fetch,
          nowSecondsImpl: () => 1_700_000_000,
          nonceFactoryImpl: () => "nonce-start",
          readFileImpl: createReadFileMock(
            fixture,
          ) as unknown as typeof import("node:fs/promises").readFile,
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com/",
            proxyUrl: "https://stale.proxy.clawdentity.com",
            humanName: INITIATOR_PROFILE.humanName,
          }),
          getConfigDirImpl: () => "/tmp/.clawdentity",
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_PAIR_PROXY_URL_MISMATCH",
    });
  });

  it("routes confirm to ticket issuer proxy when local proxy origin differs", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://beta.proxy.example",
          },
          { status: 200 },
        );
      }

      expect(url).toBe("https://alpha.proxy.example/pair/confirm");
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
        responderProfile?: { proxyOrigin?: string };
      };
      expect(requestBody.responderProfile?.proxyOrigin).toBe(
        "https://beta.proxy.example",
      );

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
          responderProfile: RESPONDER_PROFILE,
        },
        { status: 201 },
      );
    });

    const result = await confirmPairing(
      "beta",
      {
        ticket,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl: vi.fn(
          async () => undefined,
        ) as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl: vi.fn(
          async () => undefined,
        ) as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl: vi.fn(
          async () => undefined,
        ) as unknown as typeof import("node:fs/promises").chmod,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.proxyUrl).toBe("https://alpha.proxy.example/");
  });

  it("normalizes wrapped tickets before pair status request", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const wrappedTicket = `\`\n${ticket.slice(0, 18)}\n${ticket.slice(18)}\n\``;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
        ticket?: string;
      };
      expect(requestBody.ticket).toBe(ticket);

      return Response.json(
        {
          status: "pending",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });

    const result = await getPairingStatus(
      "alpha",
      {
        ticket: wrappedTicket,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.status).toBe("pending");
  });

  it("confirms pairing with qr-file ticket decode", async () => {
    const fixture = await createPairFixture();
    const unlinkImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const writeFileImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const qrTicket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
          responderProfile: RESPONDER_PROFILE,
        },
        { status: 201 },
      );
    });

    const result = await confirmPairing(
      "beta",
      {
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
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        qrDecodeImpl: () => qrTicket,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.paired).toBe(true);
    expect(result.proxyUrl).toBe("https://alpha.proxy.example/");
    expect(result.peerAlias).toBe("peer-11111111");
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Claw ${fixture.ait}`);
    expect(headers.get("x-claw-proof")).toBeTruthy();
    expect(headers.get("x-claw-body-sha256")).toBeTruthy();
    expect(headers.get("x-claw-owner-pat")).toBeNull();
    expect(headers.get("x-claw-timestamp")).toBe("1700000000");
    expect(headers.get("x-claw-nonce")).toBe("nonce-confirm");
    expect(String(init?.body ?? "")).toContain(qrTicket);
    expect(String(init?.body ?? "")).toContain("responderProfile");
    expect(unlinkImpl).toHaveBeenCalledTimes(1);
    expect(unlinkImpl).toHaveBeenCalledWith("/tmp/pair.png");
    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    expect(chmodImpl).toHaveBeenCalledTimes(1);
  });

  it("syncs OpenClaw relay peers snapshot after pair confirm", async () => {
    const fixture = await createPairFixture();
    const runtimeConfigPath = "/tmp/.clawdentity/openclaw-relay.json";
    const relayPeersPath =
      "/tmp/.openclaw/hooks/transforms/clawdentity-peers.json";
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;

    const readFileImpl = vi.fn(
      async (filePath: string, _encoding?: BufferEncoding) => {
        if (filePath.endsWith("/ait.jwt")) {
          return fixture.ait;
        }

        if (filePath.endsWith("/secret.key")) {
          return fixture.secretKeyBase64url;
        }

        if (filePath === runtimeConfigPath) {
          return JSON.stringify({
            openclawBaseUrl: "http://127.0.0.1:18789",
            relayTransformPeersPath: relayPeersPath,
          });
        }

        if (filePath === relayPeersPath) {
          return JSON.stringify({ peers: {} });
        }

        throw buildErrnoError("ENOENT");
      },
    );
    const writeFileImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      return Response.json(
        {
          paired: true,
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
          responderProfile: RESPONDER_PROFILE,
        },
        { status: 201 },
      );
    });

    const result = await confirmPairing(
      "beta",
      {
        ticket,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl:
          readFileImpl as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.paired).toBe(true);
    expect(result.peerAlias).toBe("peer-11111111");
    expect(writeFileImpl).toHaveBeenCalledWith(
      "/tmp/.clawdentity/peers.json",
      expect.any(String),
      "utf8",
    );
    expect(writeFileImpl).toHaveBeenCalledWith(
      relayPeersPath,
      expect.any(String),
      "utf8",
    );
    expect(mkdirImpl).toHaveBeenCalledTimes(2);
    expect(chmodImpl).toHaveBeenCalledTimes(2);
  });

  it("checks pending pair status without persisting peers", async () => {
    const fixture = await createPairFixture();
    const writeFileImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      return Response.json(
        {
          status: "pending",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });

    const result = await getPairingStatus(
      "alpha",
      {
        ticket,
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.status).toBe("pending");
    expect(result.proxyUrl).toBe("https://alpha.proxy.example/");
    expect(result.peerAlias).toBeUndefined();
    expect(writeFileImpl).toHaveBeenCalledTimes(0);
    expect(mkdirImpl).toHaveBeenCalledTimes(0);
    expect(chmodImpl).toHaveBeenCalledTimes(0);
  });

  it("polls pair status until confirmed and persists peer for initiator", async () => {
    const fixture = await createPairFixture();
    const writeFileImpl = vi.fn(
      async (
        _filePath: string,
        _data: string | Uint8Array,
        _encoding?: BufferEncoding,
      ) => undefined,
    );
    const mkdirImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const sleepImpl = vi.fn(async () => undefined);
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const statusResponses = [
      {
        status: "pending",
        initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
        initiatorProfile: INITIATOR_PROFILE,
        expiresAt: "2026-02-18T00:00:00.000Z",
      },
      {
        status: "confirmed",
        initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
        initiatorProfile: INITIATOR_PROFILE,
        responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
        responderProfile: {
          ...RESPONDER_PROFILE,
          proxyOrigin: "https://beta.proxy.example",
        },
        expiresAt: "2026-02-18T00:00:00.000Z",
        confirmedAt: "2026-02-18T00:00:05.000Z",
      },
    ];
    let statusIndex = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          {
            status: "ok",
            proxyUrl: "https://alpha.proxy.example",
          },
          { status: 200 },
        );
      }

      const payload =
        statusResponses[Math.min(statusIndex, statusResponses.length - 1)];
      statusIndex += 1;
      return Response.json(payload, { status: 200 });
    });

    const nowSequence = [1_700_000_000, 1_700_000_001, 1_700_000_002];
    const result = await getPairingStatus(
      "alpha",
      {
        ticket,
        wait: true,
        waitSeconds: "10",
        pollIntervalSeconds: "1",
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => nowSequence.shift() ?? 1_700_000_003,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => "/tmp/.clawdentity",
        sleepImpl,
      },
    );

    expect(result.status).toBe("confirmed");
    expect(result.peerAlias).toBe("peer-22222222");
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(writeFileImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mkdirImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(chmodImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
    const peerWriteCall = writeFileImpl.mock.calls.find(([filePath]) =>
      String(filePath).endsWith("/peers.json"),
    );
    const persistedPeers = JSON.parse(String(peerWriteCall?.[1] ?? "{}")) as {
      peers: {
        [key: string]: {
          did: string;
          proxyUrl: string;
        };
      };
    };
    expect(persistedPeers.peers["peer-22222222"]?.proxyUrl).toBe(
      "https://beta.proxy.example/hooks/agent",
    );
  });

  it("retries transient polling failures and resolves metadata only once", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const mkdirImpl = vi.fn(async () => undefined);
    const writeFileImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const unlinkImpl = vi.fn(async () => undefined);
    const sleepImpl = vi.fn(async () => undefined);
    let statusAttempt = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          { status: "ok", proxyUrl: "https://alpha.proxy.example" },
          { status: 200 },
        );
      }

      statusAttempt += 1;
      if (statusAttempt <= 2) {
        return Response.json(
          { error: { code: "PROXY_PAIR_STATE_UNAVAILABLE", message: "busy" } },
          { status: 503 },
        );
      }
      if (statusAttempt === 3) {
        return Response.json(
          {
            status: "pending",
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            expiresAt: "2026-02-18T00:00:00.000Z",
          },
          { status: 200 },
        );
      }
      return Response.json(
        {
          status: "confirmed",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
          responderProfile: RESPONDER_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
          confirmedAt: "2026-02-18T00:00:05.000Z",
        },
        { status: 200 },
      );
    });

    const result = await getPairingStatus(
      "alpha",
      {
        ticket,
        wait: true,
        waitSeconds: "120",
      },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: (() => {
          let now = 1_700_000_000;
          return () => now++;
        })(),
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: createReadFileMock(
          fixture,
        ) as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        unlinkImpl:
          unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
        getConfigDirImpl: () => "/tmp/.clawdentity",
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        sleepImpl,
      },
    );

    expect(result.status).toBe("confirmed");
    expect(
      fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/v1/metadata"),
      ).length,
    ).toBe(1);
    expect(sleepImpl).toHaveBeenCalled();
    expect(unlinkImpl).toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/pending/alpha.json",
    );
  });

  it("persists pending ticket and prints recovery guidance on timeout", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const mkdirImpl = vi.fn(async () => undefined);
    const writeFileImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const unlinkImpl = vi.fn(async () => undefined);
    const sleepImpl = vi.fn(async () => undefined);
    const writeStdoutLineImpl = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          { status: "ok", proxyUrl: "https://alpha.proxy.example" },
          { status: 200 },
        );
      }

      return Response.json(
        {
          status: "pending",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });
    const nowSequence = [1000, 1000, 1001, 1002];

    await expect(
      getPairingStatus(
        "alpha",
        {
          ticket,
          wait: true,
          waitSeconds: "2",
        },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          nowSecondsImpl: () => nowSequence.shift() ?? 1002,
          nonceFactoryImpl: () => "nonce-status",
          readFileImpl: createReadFileMock(
            fixture,
          ) as unknown as typeof import("node:fs/promises").readFile,
          writeFileImpl:
            writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
          mkdirImpl:
            mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
          chmodImpl:
            chmodImpl as unknown as typeof import("node:fs/promises").chmod,
          unlinkImpl:
            unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
          getConfigDirImpl: () => "/tmp/.clawdentity",
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com/",
          }),
          sleepImpl,
          writeStdoutLineImpl,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_PAIR_STATUS_WAIT_TIMEOUT",
    });

    expect(writeFileImpl).toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/pending/alpha.json",
      expect.any(String),
      "utf8",
    );
    expect(unlinkImpl).not.toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/pending/alpha.json",
    );
    expect(
      writeStdoutLineImpl.mock.calls.some(([message]) =>
        String(message).includes("clawdentity pair recover alpha"),
      ),
    ).toBe(true);
  });

  it("handles SIGINT cancellation with recovery hint and keeps pending ticket", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const writeFileImpl = vi.fn(async () => undefined);
    const unlinkImpl = vi.fn(async () => undefined);
    const writeStdoutLineImpl = vi.fn();
    let sigintHandler: (() => void) | undefined;
    const registerSigintHandlerImpl = vi.fn((handler: () => void) => {
      sigintHandler = handler;
    });
    const unregisterSigintHandlerImpl = vi.fn(() => undefined);
    const sleepImpl = vi.fn(async () => {
      sigintHandler?.();
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/metadata")) {
        return Response.json(
          { status: "ok", proxyUrl: "https://alpha.proxy.example" },
          { status: 200 },
        );
      }

      return Response.json(
        {
          status: "pending",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
        },
        { status: 200 },
      );
    });

    await expect(
      getPairingStatus(
        "alpha",
        {
          ticket,
          wait: true,
          waitSeconds: "30",
        },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          nowSecondsImpl: (() => {
            let now = 1_700_000_000;
            return () => now++;
          })(),
          nonceFactoryImpl: () => "nonce-status",
          readFileImpl: createReadFileMock(
            fixture,
          ) as unknown as typeof import("node:fs/promises").readFile,
          writeFileImpl:
            writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
          mkdirImpl: vi.fn(
            async () => undefined,
          ) as unknown as typeof import("node:fs/promises").mkdir,
          chmodImpl: vi.fn(
            async () => undefined,
          ) as unknown as typeof import("node:fs/promises").chmod,
          unlinkImpl:
            unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
          getConfigDirImpl: () => "/tmp/.clawdentity",
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com/",
          }),
          sleepImpl,
          writeStdoutLineImpl,
          registerSigintHandlerImpl,
          unregisterSigintHandlerImpl,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_PAIR_STATUS_WAIT_CANCELLED",
    });

    expect(registerSigintHandlerImpl).toHaveBeenCalledTimes(1);
    expect(unregisterSigintHandlerImpl).toHaveBeenCalledTimes(1);
    expect(unlinkImpl).not.toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/pending/alpha.json",
    );
    expect(
      writeStdoutLineImpl.mock.calls.some(([message]) =>
        String(message).includes("Pairing wait cancelled"),
      ),
    ).toBe(true);
  });

  it("recovers confirmed pending pairing and clears pending ticket state", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const readFileImpl = vi.fn(
      async (filePath: string, _encoding?: BufferEncoding) => {
        if (filePath.endsWith("/ait.jwt")) {
          return fixture.ait;
        }
        if (filePath.endsWith("/secret.key")) {
          return fixture.secretKeyBase64url;
        }
        if (filePath.endsWith("/pairing/pending/alpha.json")) {
          return JSON.stringify({
            agentName: "alpha",
            ticket,
            proxyUrl: "https://alpha.proxy.example/",
            createdAt: "2026-02-18T00:00:00.000Z",
          });
        }
        throw buildErrnoError("ENOENT");
      },
    );
    const writeFileImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const unlinkImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          status: "confirmed",
          initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
          responderProfile: RESPONDER_PROFILE,
          expiresAt: "2026-02-18T00:00:00.000Z",
          confirmedAt: "2026-02-18T00:00:05.000Z",
        },
        { status: 200 },
      ),
    );

    const result = await recoverPairing(
      "alpha",
      {},
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl:
          readFileImpl as unknown as typeof import("node:fs/promises").readFile,
        writeFileImpl:
          writeFileImpl as unknown as typeof import("node:fs/promises").writeFile,
        mkdirImpl:
          mkdirImpl as unknown as typeof import("node:fs/promises").mkdir,
        chmodImpl:
          chmodImpl as unknown as typeof import("node:fs/promises").chmod,
        unlinkImpl:
          unlinkImpl as unknown as typeof import("node:fs/promises").unlink,
        getConfigDirImpl: () => "/tmp/.clawdentity",
      },
    );

    expect(result.status).toBe("confirmed");
    expect(unlinkImpl).toHaveBeenCalledWith(
      "/tmp/.clawdentity/pairing/pending/alpha.json",
    );
  });

  it("fails recover when no pending pairing exists", async () => {
    const fixture = await createPairFixture();
    await expect(
      recoverPairing(
        "alpha",
        {},
        {
          readFileImpl: createReadFileMock(
            fixture,
          ) as unknown as typeof import("node:fs/promises").readFile,
          getConfigDirImpl: () => "/tmp/.clawdentity",
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_PAIR_RECOVER_NOT_FOUND",
    });
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
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = resetClawdentityEnv(previousEnv);
  });

  afterEach(() => {
    process.env = previousEnv;
  });

  it("prints pairing ticket from pair start", async () => {
    const fixture = await createPairFixture();
    const command = createPairCommand({
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/v1/metadata")) {
          return Response.json(
            {
              status: "ok",
              proxyUrl: "https://alpha.proxy.example",
            },
            { status: 200 },
          );
        }

        return Response.json(
          {
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            ticket: "clwpair1_eyJ2IjoxfQ",
            expiresAt: "2026-02-18T00:00:00.000Z",
          },
          { status: 200 },
        );
      }) as unknown as typeof fetch,
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
        registryUrl: "https://dev.registry.clawdentity.com/",
        apiKey: "clw_pat_configured",
        humanName: INITIATOR_PROFILE.humanName,
      }),
      getConfigDirImpl: () => "/tmp/.clawdentity",
    });

    const result = await runPairCommand(["start", "alpha", "--qr"], command);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Pairing ticket created");
    expect(result.stdout).toContain("Ticket: clwpair1_eyJ2IjoxfQ");
    expect(result.stdout).toContain("QR File: ");
  });

  it("prints saved peer alias from pair confirm", async () => {
    const fixture = await createPairFixture();
    const qrTicket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const command = createPairCommand({
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/v1/metadata")) {
          return Response.json(
            {
              status: "ok",
              proxyUrl: "https://alpha.proxy.example",
            },
            { status: 200 },
          );
        }

        return Response.json(
          {
            paired: true,
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
            responderProfile: RESPONDER_PROFILE,
          },
          { status: 201 },
        );
      }) as unknown as typeof fetch,
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-confirm",
      readFileImpl: createReadFileMock(
        fixture,
      ) as unknown as typeof import("node:fs/promises").readFile,
      writeFileImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").writeFile,
      mkdirImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").mkdir,
      chmodImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").chmod,
      unlinkImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").unlink,
      qrDecodeImpl: () => qrTicket,
      resolveConfigImpl: async () => ({
        registryUrl: "https://registry.clawdentity.com/",
        humanName: RESPONDER_PROFILE.humanName,
      }),
      getConfigDirImpl: () => "/tmp/.clawdentity",
    });

    const result = await runPairCommand(
      ["confirm", "beta", "--qr-file", "/tmp/pair.png"],
      command,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Pairing confirmed");
    expect(result.stdout).toContain("Peer alias saved: peer-11111111");
  });

  it("prints pairing status from pair status", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const command = createPairCommand({
      fetchImpl: (async (url: string) => {
        if (url.endsWith("/v1/metadata")) {
          return Response.json(
            {
              status: "ok",
              proxyUrl: "https://alpha.proxy.example",
            },
            { status: 200 },
          );
        }

        return Response.json(
          {
            status: "pending",
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            expiresAt: "2026-02-18T00:00:00.000Z",
          },
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-status",
      readFileImpl: createReadFileMock(
        fixture,
      ) as unknown as typeof import("node:fs/promises").readFile,
      resolveConfigImpl: async () => ({
        registryUrl: "https://registry.clawdentity.com/",
      }),
      getConfigDirImpl: () => "/tmp/.clawdentity",
    });

    const result = await runPairCommand(
      ["status", "alpha", "--ticket", ticket],
      command,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Status: pending");
    expect(result.stdout).toContain(
      "Initiator Agent DID: did:claw:agent:01HAAA11111111111111111111",
    );
  });

  it("prints recovered output from pair recover", async () => {
    const fixture = await createPairFixture();
    const ticket = `clwpair1_${Buffer.from(
      JSON.stringify({ iss: "https://alpha.proxy.example" }),
    ).toString("base64url")}`;
    const readFileImpl = vi.fn(
      async (filePath: string, _encoding?: BufferEncoding) => {
        if (filePath.endsWith("/ait.jwt")) {
          return fixture.ait;
        }
        if (filePath.endsWith("/secret.key")) {
          return fixture.secretKeyBase64url;
        }
        if (filePath.endsWith("/pairing/pending/alpha.json")) {
          return JSON.stringify({
            agentName: "alpha",
            ticket,
            proxyUrl: "https://alpha.proxy.example/",
            createdAt: "2026-02-18T00:00:00.000Z",
          });
        }
        throw buildErrnoError("ENOENT");
      },
    );

    const command = createPairCommand({
      fetchImpl: (async () =>
        Response.json(
          {
            status: "confirmed",
            initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            responderAgentDid: "did:claw:agent:01HBBB22222222222222222222",
            responderProfile: RESPONDER_PROFILE,
            expiresAt: "2026-02-18T00:00:00.000Z",
            confirmedAt: "2026-02-18T00:00:05.000Z",
          },
          { status: 200 },
        )) as unknown as typeof fetch,
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-status",
      readFileImpl:
        readFileImpl as unknown as typeof import("node:fs/promises").readFile,
      writeFileImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").writeFile,
      mkdirImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").mkdir,
      chmodImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").chmod,
      unlinkImpl: vi.fn(
        async () => undefined,
      ) as unknown as typeof import("node:fs/promises").unlink,
      getConfigDirImpl: () => "/tmp/.clawdentity",
    });

    const result = await runPairCommand(["recover", "alpha"], command);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Pairing recovered and saved");
    expect(result.stdout).toContain("Status: confirmed");
  });
});
