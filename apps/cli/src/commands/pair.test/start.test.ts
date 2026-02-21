import { describe, expect, it, vi } from "vitest";
import { startPairing } from "../pair.js";
import {
  asFetch,
  asMkdir,
  asReaddir,
  asReadFile,
  asUnlink,
  asWriteFile,
  createPairFixture,
  createReadFileMock,
  INITIATOR_PROFILE,
  PAIR_CONFIG_DIR,
  setupPairTestEnv,
} from "./helpers.js";

describe("pair start helpers", () => {
  setupPairTestEnv();

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
        qr: true,
      },
      {
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl: asReadFile(readFileImpl),
        writeFileImpl: asWriteFile(writeFileImpl),
        mkdirImpl: asMkdir(mkdirImpl),
        readdirImpl: asReaddir(readdirImpl),
        unlinkImpl: asUnlink(unlinkImpl),
        qrEncodeImpl: async () => new Uint8Array([1, 2, 3]),
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.registry.clawdentity.com/",
          humanName: INITIATOR_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
  });

  it("uses CLAWDENTITY_PROXY_URL when no proxy override options are present", async () => {
    process.env.CLAWDENTITY_PROXY_URL = "https://env.proxy.example";
    const fixture = await createPairFixture();

    const result = await startPairing(
      "alpha",
      {},
      {
        fetchImpl: asFetch(async () =>
          Response.json(
            {
              initiatorAgentDid: "did:claw:agent:01HAAA11111111111111111111",
              initiatorProfile: INITIATOR_PROFILE,
              ticket: "clwpair1_eyJ2IjoxfQ",
              expiresAt: "2026-02-18T00:00:00.000Z",
            },
            { status: 200 },
          ),
        ),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.registry.clawdentity.com/",
          humanName: INITIATOR_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
        fetchImpl: asFetch(async (url: string) => {
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
        }),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-start",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        resolveConfigImpl: async () => ({
          registryUrl: "https://dev.registry.clawdentity.com/",
          proxyUrl: "https://saved.proxy.example",
          humanName: INITIATOR_PROFILE.humanName,
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
          fetchImpl: asFetch(async (url: string) => {
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
          }),
          nowSecondsImpl: () => 1_700_000_000,
          nonceFactoryImpl: () => "nonce-start",
          readFileImpl: asReadFile(createReadFileMock(fixture)),
          resolveConfigImpl: async () => ({
            registryUrl: "https://registry.clawdentity.com/",
            proxyUrl: "https://stale.proxy.clawdentity.com",
            humanName: INITIATOR_PROFILE.humanName,
          }),
          getConfigDirImpl: () => PAIR_CONFIG_DIR,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLI_PAIR_PROXY_URL_MISMATCH",
    });
  });
});
