import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { Command } from "commander";
import { vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../config/manager.js", () => ({
  getConfigDir: vi.fn(() => "/mock-home/.clawdentity"),
  resolveConfig: vi.fn(),
}));

vi.mock("@clawdentity/sdk", () => ({
  createLogger: vi.fn(() => ({
    child: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  decodeAIT: vi.fn(),
  encodeEd25519SignatureBase64url: vi.fn(),
  encodeEd25519KeypairBase64url: vi.fn(),
  generateEd25519Keypair: vi.fn(),
  nowUtcMs: vi.fn(() => 1_700_000_000_000),
  refreshAgentAuthWithClawProof: vi.fn(),
  signEd25519: vi.fn(),
  toIso: vi.fn((value: Date | string | number) =>
    new Date(value).toISOString(),
  ),
}));

import {
  type DecodedAit,
  decodeAIT,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  nowUtcMs,
  refreshAgentAuthWithClawProof,
  signEd25519,
  toIso,
} from "@clawdentity/sdk";
import { resolveConfig } from "../../config/manager.js";
import { createAgentCommand } from "../agent.js";

export const DEFAULT_REGISTRY_URL = "https://registry.clawdentity.com";
export const DEFAULT_API_KEY = "pat_123";
export const DEFAULT_AGENT_NAME = "agent-01";
export const DEFAULT_AGENT_DID =
  "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4";
export const DEFAULT_AGENT_ID = "01HF7YAT00W6W7CM7N3W5FDXT4";

export const mockedAccess = vi.mocked(access);
export const mockedChmod = vi.mocked(chmod);
export const mockedMkdir = vi.mocked(mkdir);
export const mockedReadFile = vi.mocked(readFile);
export const mockedRename = vi.mocked(rename);
export const mockedUnlink = vi.mocked(unlink);
export const mockedWriteFile = vi.mocked(writeFile);
export const mockedResolveConfig = vi.mocked(resolveConfig);
export const mockedGenerateEd25519Keypair = vi.mocked(generateEd25519Keypair);
export const mockedNowUtcMs = vi.mocked(nowUtcMs);
export const mockedRefreshAgentAuthWithClawProof = vi.mocked(
  refreshAgentAuthWithClawProof,
);
export const mockedSignEd25519 = vi.mocked(signEd25519);
export const mockedEncodeEd25519SignatureBase64url = vi.mocked(
  encodeEd25519SignatureBase64url,
);
export const mockedEncodeEd25519KeypairBase64url = vi.mocked(
  encodeEd25519KeypairBase64url,
);
export const mockedDecodeAIT = vi.mocked(decodeAIT);
export const mockedToIso = vi.mocked(toIso);

export const mockFetch = vi.fn<typeof fetch>();

export const buildErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

export const createJsonResponse = (status: number, body: unknown): Response => {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
};

export const agentPath = (agentName: string, fileName: string): string =>
  `/mock-home/.clawdentity/agents/${agentName}/${fileName}`;

export const runAgentCommand = async (args: string[]) => {
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

  const command = createAgentCommand();
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
    outputError: (message) => stderr.push(message),
  });

  const root = new Command("clawdentity");
  root.addCommand(command);

  try {
    await root.parseAsync(["node", "clawdentity", "agent", ...args]);
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

export const resetAgentTestMocks = () => {
  vi.clearAllMocks();
  mockFetch.mockReset();
};

export const stubAgentFetch = () => {
  vi.stubGlobal("fetch", mockFetch);
};

export const resetProcessExitCode = () => {
  process.exitCode = undefined;
};

export const cleanupAgentTestGlobals = () => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
};

export const setupCreateCommandDefaults = () => {
  mockedResolveConfig.mockResolvedValue({
    registryUrl: DEFAULT_REGISTRY_URL,
    apiKey: DEFAULT_API_KEY,
  });

  mockedAccess.mockRejectedValue(buildErrnoError("ENOENT"));
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedRename.mockResolvedValue(undefined);
  mockedUnlink.mockResolvedValue(undefined);
  mockedChmod.mockResolvedValue(undefined);

  mockedGenerateEd25519Keypair.mockResolvedValue({
    publicKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    secretKey: Uint8Array.from({ length: 32 }, (_, index) => 64 - index),
  });
  mockedNowUtcMs.mockReturnValue(1_700_000_000_000);
  mockedToIso.mockImplementation((value: Date | string | number) =>
    new Date(value).toISOString(),
  );

  mockedEncodeEd25519KeypairBase64url.mockReturnValue({
    publicKey: "public-key-b64url",
    secretKey: "secret-key-b64url",
  });

  mockedSignEd25519.mockResolvedValue(Uint8Array.from([1, 2, 3]));
  mockedEncodeEd25519SignatureBase64url.mockReturnValue(
    "challenge-signature-b64url",
  );

  mockFetch.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/agents/challenge")) {
      return createJsonResponse(201, {
        challengeId: "01JCHALLENGEID1234567890ABC",
        nonce: "challenge-nonce-b64url",
        ownerDid:
          "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
        expiresAt: "2030-01-01T00:05:00.000Z",
      });
    }

    return createJsonResponse(201, {
      agent: {
        did: DEFAULT_AGENT_DID,
        name: DEFAULT_AGENT_NAME,
        framework: "openclaw",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      ait: "ait.jwt.value",
      agentAuth: {
        tokenType: "Bearer",
        accessToken: "clw_agt_access_token",
        accessExpiresAt: "2030-01-01T00:15:00.000Z",
        refreshToken: "clw_rft_refresh_token",
        refreshExpiresAt: "2030-01-31T00:00:00.000Z",
      },
    });
  });
};

type AuthReadFileOptions = {
  missingRegistryAuth?: boolean;
  registryUrl?: string;
};

export const setupAuthRefreshReadFiles = (
  options: AuthReadFileOptions = {},
) => {
  const { missingRegistryAuth = false, registryUrl = DEFAULT_REGISTRY_URL } =
    options;
  mockedReadFile.mockImplementation(async (path) => {
    const filePath = String(path);
    if (filePath.endsWith("/ait.jwt")) {
      return "ait.jwt.value";
    }
    if (filePath.endsWith("/identity.json")) {
      return JSON.stringify({
        did: DEFAULT_AGENT_DID,
        registryUrl,
      });
    }
    if (filePath.endsWith("/secret.key")) {
      return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    }
    if (filePath.endsWith("/registry-auth.json")) {
      if (missingRegistryAuth) {
        throw buildErrnoError("ENOENT");
      }
      return JSON.stringify({
        tokenType: "Bearer",
        accessToken: "clw_agt_old_access",
        accessExpiresAt: "2030-01-01T00:15:00.000Z",
        refreshToken: "clw_rft_old_refresh",
        refreshExpiresAt: "2030-01-31T00:00:00.000Z",
      });
    }

    throw buildErrnoError("ENOENT");
  });
};

export const setupAuthRefreshDefaults = () => {
  setupAuthRefreshReadFiles();
  mockedRefreshAgentAuthWithClawProof.mockResolvedValue({
    tokenType: "Bearer",
    accessToken: "clw_agt_new_access",
    accessExpiresAt: "2030-01-02T00:15:00.000Z",
    refreshToken: "clw_rft_new_refresh",
    refreshExpiresAt: "2030-02-01T00:00:00.000Z",
  });
};

export const setupRevokeDefaults = () => {
  mockedResolveConfig.mockResolvedValue({
    registryUrl: DEFAULT_REGISTRY_URL,
    apiKey: DEFAULT_API_KEY,
  });

  mockedReadFile.mockResolvedValue(
    JSON.stringify({
      did: DEFAULT_AGENT_DID,
    }),
  );

  mockFetch.mockResolvedValue(
    createJsonResponse(204, {
      ok: true,
    }),
  );
};

export const decodedAitFixture: DecodedAit = {
  header: {
    alg: "EdDSA",
    typ: "AIT",
    kid: "key-01",
  },
  claims: {
    iss: "https://registry.clawdentity.dev",
    sub: "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
    ownerDid:
      "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7",
    name: "agent-01",
    framework: "openclaw",
    cnf: {
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: "pub-key",
      },
    },
    iat: 1672531100,
    nbf: 1672531100,
    exp: 1672531200,
    jti: "01HF7YAT00W6W7CM7N3W5FDXT4",
  },
};

export const setupInspectDefaults = () => {
  mockedReadFile.mockResolvedValue("mock-ait-token");
  mockedDecodeAIT.mockReturnValue(decodedAitFixture);
};
