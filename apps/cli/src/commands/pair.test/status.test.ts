import { describe, expect, it, vi } from "vitest";
import { getPairingStatus } from "../pair.js";
import {
  asChmod,
  asFetch,
  asMkdir,
  asReadFile,
  asWriteFile,
  createPairFixture,
  createPairTicket,
  createReadFileMock,
  INITIATOR_PROFILE,
  PAIR_CONFIG_DIR,
  RESPONDER_PROFILE,
  setupPairTestEnv,
} from "./helpers.js";

describe("pair status helpers", () => {
  setupPairTestEnv();

  it("normalizes wrapped tickets before pair status request", async () => {
    const fixture = await createPairFixture();
    const ticket = createPairTicket("https://alpha.proxy.example");
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
          initiatorAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
      },
    );

    expect(result.status).toBe("pending");
  });

  it("checks pending pair status without persisting peers", async () => {
    const fixture = await createPairFixture();
    const writeFileImpl = vi.fn(async () => undefined);
    const mkdirImpl = vi.fn(async () => undefined);
    const chmodImpl = vi.fn(async () => undefined);
    const ticket = createPairTicket("https://alpha.proxy.example");
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
          initiatorAgentDid:
            "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => 1_700_000_000,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        writeFileImpl: asWriteFile(writeFileImpl),
        mkdirImpl: asMkdir(mkdirImpl),
        chmodImpl: asChmod(chmodImpl),
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
    const ticket = createPairTicket("https://alpha.proxy.example");
    const statusResponses = [
      {
        status: "pending",
        initiatorAgentDid:
          "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
        initiatorProfile: INITIATOR_PROFILE,
        expiresAt: "2026-02-18T00:00:00.000Z",
      },
      {
        status: "confirmed",
        initiatorAgentDid:
          "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
        initiatorProfile: INITIATOR_PROFILE,
        responderAgentDid:
          "did:cdi:registry.clawdentity.com:agent:01HBBB22222222222222222222",
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
        fetchImpl: asFetch(fetchImpl),
        nowSecondsImpl: () => nowSequence.shift() ?? 1_700_000_003,
        nonceFactoryImpl: () => "nonce-status",
        readFileImpl: asReadFile(createReadFileMock(fixture)),
        writeFileImpl: asWriteFile(writeFileImpl),
        mkdirImpl: asMkdir(mkdirImpl),
        chmodImpl: asChmod(chmodImpl),
        resolveConfigImpl: async () => ({
          registryUrl: "https://registry.clawdentity.com/",
        }),
        getConfigDirImpl: () => PAIR_CONFIG_DIR,
        sleepImpl,
      },
    );

    expect(result.status).toBe("confirmed");
    expect(result.peerAlias).toBe("peer-22222222");
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(writeFileImpl).toHaveBeenCalledTimes(1);
    expect(mkdirImpl).toHaveBeenCalledTimes(1);
    expect(chmodImpl).toHaveBeenCalledTimes(1);
    const peerWriteCall = writeFileImpl.mock.calls[0];
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
});
