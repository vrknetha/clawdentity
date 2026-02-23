import { describe, expect, it, vi } from "vitest";
import { confirmPairing } from "../pair.js";
import {
  asChmod,
  asFetch,
  asMkdir,
  asReadFile,
  asUnlink,
  asWriteFile,
  buildErrnoError,
  createPairFixture,
  createPairTicket,
  createReadFileMock,
  INITIATOR_PROFILE,
  PAIR_CONFIG_DIR,
  RESPONDER_PROFILE,
  setupPairTestEnv,
} from "./helpers.js";

describe("pair confirm helpers", () => {
  setupPairTestEnv();

  it("routes confirm to ticket issuer proxy when local proxy origin differs", async () => {
    const fixture = await createPairFixture();
    const ticket = createPairTicket("https://alpha.proxy.example");
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
          initiatorAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HBBB22222222222222222222",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        writeFileImpl: asWriteFile(vi.fn(async () => undefined)),
        mkdirImpl: asMkdir(vi.fn(async () => undefined)),
        chmodImpl: asChmod(vi.fn(async () => undefined)),
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
      },
    );

    expect(result.proxyUrl).toBe("https://alpha.proxy.example/");
  });

  it("confirms pairing with qr-file ticket decode", async () => {
    const fixture = await createPairFixture();
    const unlinkImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const writeFileImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const qrTicket = createPairTicket("https://alpha.proxy.example");
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
          initiatorAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HBBB22222222222222222222",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        unlinkImpl: asUnlink(unlinkImpl),
        mkdirImpl: asMkdir(mkdirImpl),
        writeFileImpl: asWriteFile(writeFileImpl),
        chmodImpl: asChmod(chmodImpl),
        qrDecodeImpl: () => qrTicket,
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
    const ticket = createPairTicket("https://alpha.proxy.example");

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
          initiatorAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
          initiatorProfile: INITIATOR_PROFILE,
          responderAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HBBB22222222222222222222",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-confirm",
        readFileImpl: asReadFile(readFileImpl),
        writeFileImpl: asWriteFile(writeFileImpl),
        mkdirImpl: asMkdir(mkdirImpl),
        chmodImpl: asChmod(chmodImpl),
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
          humanName: RESPONDER_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
});
