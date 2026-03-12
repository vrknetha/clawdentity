import { describe, expect, it, vi } from "vitest";
import { createPairCommand } from "../pair.js";
import {
  asChmod,
  asFetch,
  asMkdir,
  asReadFile,
  asUnlink,
  asWriteFile,
  createPairFixture,
  createPairTicket,
  createReadFileMock,
  INITIATOR_PROFILE,
  PAIR_CONFIG_DIR,
  RESPONDER_PROFILE,
  runPairCommand,
  setupPairTestEnv,
} from "./helpers.js";

describe("pair command output", () => {
  setupPairTestEnv();

  it("prints pairing ticket from pair start", async () => {
    const fixture = await createPairFixture();
    const command = createPairCommand({
      fetchImpl: asFetch(async (url: string) => {
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
            initiatorAgentDid:
              "did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
            initiatorProfile: INITIATOR_PROFILE,
            ticket: "clwpair1_eyJ2IjoxfQ",
            expiresAt: "2026-02-18T00:00:00.000Z",
          },
          { status: 200 },
        );
      }),
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-start",
      qrEncodeImpl: async () => new Uint8Array([1, 2, 3]),
      readFileImpl: asReadFile(createReadFileMock(fixture)),
      writeFileImpl: asWriteFile(vi.fn(async () => undefined)),
      mkdirImpl: asMkdir(vi.fn(async () => undefined)),
      resolveConfigImpl: async () => ({
        registryUrl: "https://dev.registry.clawdentity.com/",
        apiKey: "clw_pat_configured",
        humanName: INITIATOR_PROFILE.humanName,
      }),
      getConfigDirImpl: () => PAIR_CONFIG_DIR,
    });

    const result = await runPairCommand(["start", "alpha", "--qr"], command);

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Pairing ticket created");
    expect(result.stdout).toContain("Ticket: clwpair1_eyJ2IjoxfQ");
    expect(result.stdout).toContain("QR File: ");
  });

  it("prints saved peer alias from pair confirm", async () => {
    const fixture = await createPairFixture();
    const qrTicket = createPairTicket("https://alpha.proxy.example");
    const command = createPairCommand({
      fetchImpl: asFetch(async (url: string) => {
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
      }),
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-confirm",
      readFileImpl: asReadFile(createReadFileMock(fixture)),
      writeFileImpl: asWriteFile(vi.fn(async () => undefined)),
      mkdirImpl: asMkdir(vi.fn(async () => undefined)),
      chmodImpl: asChmod(vi.fn(async () => undefined)),
      unlinkImpl: asUnlink(vi.fn(async () => undefined)),
      qrDecodeImpl: () => qrTicket,
      resolveConfigImpl: async () => ({
        registryUrl: "https://registry.clawdentity.com/",
        humanName: RESPONDER_PROFILE.humanName,
      }),
      getConfigDirImpl: () => PAIR_CONFIG_DIR,
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
    const ticket = createPairTicket("https://alpha.proxy.example");
    const command = createPairCommand({
      fetchImpl: asFetch(async (url: string) => {
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
      }),
      nowSecondsImpl: () => 1_700_000_000,
      nonceFactoryImpl: () => "nonce-status",
      readFileImpl: asReadFile(createReadFileMock(fixture)),
      resolveConfigImpl: async () => ({
        registryUrl: "https://registry.clawdentity.com/",
      }),
      getConfigDirImpl: () => PAIR_CONFIG_DIR,
    });

    const result = await runPairCommand(
      ["status", "alpha", "--ticket", ticket],
      command,
    );

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("Status: pending");
    expect(result.stdout).toContain(
      "Initiator Agent DID: did:cdi:registry.clawdentity.com:agent:01HAAA11111111111111111111",
    );
  });
});
