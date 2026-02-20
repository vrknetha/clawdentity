import { readFile } from "node:fs/promises";
import {
  isRecord,
  parseJsonResponseSafe as parseResponseJson,
} from "@clawdentity/common";
import { parseCrlClaims } from "@clawdentity/protocol";
import {
  createLogger,
  nowUtcMs,
  parseRegistryConfig,
  type RegistryConfig,
  verifyAIT,
  verifyCRL,
} from "@clawdentity/sdk";
import { Command } from "commander";
import {
  readCacheFile,
  resolveConfig,
  writeCacheFile,
} from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "verify" });

const REGISTRY_KEYS_CACHE_FILE = "registry-keys.json";
const CRL_CLAIMS_CACHE_FILE = "crl-claims.json";
const REGISTRY_KEYS_CACHE_TTL_MS = 60 * 60 * 1000;
const CRL_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

type RegistrySigningKey = NonNullable<
  RegistryConfig["REGISTRY_SIGNING_KEYS"]
>[number];

type VerificationKey = {
  kid: string;
  jwk: {
    kty: "OKP";
    crv: "Ed25519";
    x: string;
  };
};

type CrlVerificationClaims = Awaited<ReturnType<typeof verifyCRL>>;

type RegistryKeysCacheEntry = {
  registryUrl: string;
  fetchedAtMs: number;
  keys: RegistrySigningKey[];
};

type CrlClaimsCacheEntry = {
  registryUrl: string;
  fetchedAtMs: number;
  claims: CrlVerificationClaims;
};

class VerifyCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyCommandError";
  }
}

const normalizeRegistryUrl = (registryUrl: string): string => {
  try {
    return new URL(registryUrl).toString();
  } catch {
    throw new VerifyCommandError(
      "verification keys unavailable (registryUrl is invalid)",
    );
  }
};

const toRegistryUrl = (registryUrl: string, path: string): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  return new URL(path, normalizedBaseUrl).toString();
};

const toExpectedIssuer = (registryUrl: string): string | undefined => {
  try {
    const hostname = new URL(registryUrl).hostname;
    if (hostname === "registry.clawdentity.com") {
      return "https://registry.clawdentity.com";
    }

    if (hostname === "dev.registry.clawdentity.com") {
      return "https://dev.registry.clawdentity.com";
    }

    return undefined;
  } catch {
    return undefined;
  }
};

const resolveToken = async (tokenOrFile: string): Promise<string> => {
  const input = tokenOrFile.trim();
  if (input.length === 0) {
    throw new VerifyCommandError("invalid token (value is empty)");
  }

  try {
    const fileContents = await readFile(input, "utf-8");
    const token = fileContents.trim();
    if (token.length === 0) {
      throw new VerifyCommandError(`invalid token (${input} is empty)`);
    }

    return token;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return input;
    }

    if (error instanceof VerifyCommandError) {
      throw error;
    }

    throw new VerifyCommandError(`invalid token (unable to read ${input})`);
  }
};

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const parseSigningKeys = (payload: unknown): RegistrySigningKey[] => {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) {
    throw new VerifyCommandError(
      "verification keys unavailable (response payload is invalid)",
    );
  }

  const parsedConfig = parseRegistryConfig({
    ENVIRONMENT: "test",
    REGISTRY_SIGNING_KEYS: JSON.stringify(payload.keys),
  });

  const keys = parsedConfig.REGISTRY_SIGNING_KEYS ?? [];
  if (keys.length === 0) {
    throw new VerifyCommandError(
      "verification keys unavailable (no signing keys were published)",
    );
  }

  return keys;
};

const parseRegistryKeysCache = (
  rawCache: string,
): RegistryKeysCacheEntry | undefined => {
  const parsed = parseJson(rawCache);
  if (!isRecord(parsed)) {
    return undefined;
  }

  const { registryUrl, fetchedAtMs, keys } = parsed;
  if (typeof registryUrl !== "string") {
    return undefined;
  }

  if (typeof fetchedAtMs !== "number") {
    return undefined;
  }

  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < 0) {
    return undefined;
  }

  try {
    const parsedKeys = parseSigningKeys({ keys });
    return {
      registryUrl,
      fetchedAtMs,
      keys: parsedKeys,
    };
  } catch {
    return undefined;
  }
};

const parseCrlCache = (rawCache: string): CrlClaimsCacheEntry | undefined => {
  const parsed = parseJson(rawCache);
  if (!isRecord(parsed)) {
    return undefined;
  }

  const { registryUrl, fetchedAtMs, claims } = parsed;
  if (typeof registryUrl !== "string") {
    return undefined;
  }

  if (typeof fetchedAtMs !== "number") {
    return undefined;
  }

  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < 0) {
    return undefined;
  }

  try {
    return {
      registryUrl,
      fetchedAtMs,
      claims: parseCrlClaims(claims),
    };
  } catch {
    return undefined;
  }
};

const toVerificationKeys = (keys: RegistrySigningKey[]): VerificationKey[] => {
  return keys
    .filter((key) => key.status === "active")
    .map((key) => ({
      kid: key.kid,
      jwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: key.x,
      },
    }));
};

const isFreshCache = (input: {
  cache: { fetchedAtMs: number; registryUrl: string } | undefined;
  nowMs: number;
  registryUrl: string;
  ttlMs: number;
}) => {
  return (
    input.cache !== undefined &&
    input.cache.registryUrl === input.registryUrl &&
    input.nowMs - input.cache.fetchedAtMs <= input.ttlMs
  );
};

const fetchRegistryKeys = async (
  registryUrl: string,
): Promise<RegistrySigningKey[]> => {
  let response: Response;

  try {
    response = await fetch(
      toRegistryUrl(registryUrl, "/.well-known/claw-keys.json"),
    );
  } catch {
    throw new VerifyCommandError(
      "verification keys unavailable (network error)",
    );
  }

  if (!response.ok) {
    throw new VerifyCommandError(
      `verification keys unavailable (status ${response.status})`,
    );
  }

  return parseSigningKeys(await parseResponseJson(response));
};

const loadRegistryKeys = async (
  registryUrl: string,
): Promise<RegistrySigningKey[]> => {
  const now = nowUtcMs();
  const rawCache = await readCacheFile(REGISTRY_KEYS_CACHE_FILE);
  const cache =
    typeof rawCache === "string" ? parseRegistryKeysCache(rawCache) : undefined;

  const isFresh = isFreshCache({
    cache,
    nowMs: now,
    registryUrl,
    ttlMs: REGISTRY_KEYS_CACHE_TTL_MS,
  });

  if (isFresh && cache) {
    return cache.keys;
  }

  const keys = await fetchRegistryKeys(registryUrl);

  await writeCacheFile(
    REGISTRY_KEYS_CACHE_FILE,
    `${JSON.stringify(
      {
        registryUrl,
        fetchedAtMs: now,
        keys,
      } satisfies RegistryKeysCacheEntry,
      null,
      2,
    )}\n`,
  );

  return keys;
};

const fetchCrlClaims = async (input: {
  expectedIssuer?: string;
  registryUrl: string;
  verificationKeys: VerificationKey[];
}): Promise<CrlVerificationClaims> => {
  let response: Response;

  try {
    response = await fetch(toRegistryUrl(input.registryUrl, "/v1/crl"));
  } catch {
    throw new VerifyCommandError(
      "revocation check unavailable (network error)",
    );
  }

  if (!response.ok) {
    throw new VerifyCommandError(
      `revocation check unavailable (status ${response.status})`,
    );
  }

  const payload = await parseResponseJson(response);
  if (!isRecord(payload) || typeof payload.crl !== "string") {
    throw new VerifyCommandError(
      "revocation check unavailable (response payload is invalid)",
    );
  }

  try {
    return await verifyCRL({
      token: payload.crl,
      registryKeys: input.verificationKeys,
      expectedIssuer: input.expectedIssuer,
    });
  } catch {
    throw new VerifyCommandError("revocation check unavailable (invalid CRL)");
  }
};

const loadCrlClaims = async (input: {
  expectedIssuer?: string;
  registryUrl: string;
  verificationKeys: VerificationKey[];
}): Promise<CrlVerificationClaims> => {
  const now = nowUtcMs();
  const rawCache = await readCacheFile(CRL_CLAIMS_CACHE_FILE);
  const cache =
    typeof rawCache === "string" ? parseCrlCache(rawCache) : undefined;

  const isFresh = isFreshCache({
    cache,
    nowMs: now,
    registryUrl: input.registryUrl,
    ttlMs: CRL_CACHE_MAX_AGE_MS,
  });

  if (isFresh && cache) {
    return cache.claims;
  }

  const claims = await fetchCrlClaims(input);

  await writeCacheFile(
    CRL_CLAIMS_CACHE_FILE,
    `${JSON.stringify(
      {
        registryUrl: input.registryUrl,
        fetchedAtMs: now,
        claims,
      } satisfies CrlClaimsCacheEntry,
      null,
      2,
    )}\n`,
  );

  return claims;
};

const toInvalidTokenReason = (error: unknown): string => {
  if (isRecord(error) && typeof error.message === "string") {
    return `invalid token (${error.message})`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return `invalid token (${error.message})`;
  }

  return "invalid token";
};

const printResult = (passed: boolean, reason: string): void => {
  if (passed) {
    writeStdoutLine(`✅ ${reason}`);
    return;
  }

  process.exitCode = 1;
  writeStdoutLine(`❌ ${reason}`);
};

const runVerify = async (tokenOrFile: string): Promise<void> => {
  const config = await resolveConfig();
  const registryUrl = normalizeRegistryUrl(config.registryUrl);
  const expectedIssuer = toExpectedIssuer(registryUrl);
  const token = await resolveToken(tokenOrFile);

  let keys: RegistrySigningKey[];
  try {
    keys = await loadRegistryKeys(registryUrl);
  } catch (error) {
    if (error instanceof VerifyCommandError) {
      printResult(false, error.message);
      return;
    }

    throw error;
  }

  const verificationKeys = toVerificationKeys(keys);
  if (verificationKeys.length === 0) {
    printResult(false, "verification keys unavailable (no active keys)");
    return;
  }

  let claims: Awaited<ReturnType<typeof verifyAIT>>;
  try {
    claims = await verifyAIT({
      token,
      registryKeys: verificationKeys,
      expectedIssuer,
    });
  } catch (error) {
    printResult(false, toInvalidTokenReason(error));
    return;
  }

  let crlClaims: CrlVerificationClaims;
  try {
    crlClaims = await loadCrlClaims({
      expectedIssuer,
      registryUrl,
      verificationKeys,
    });
  } catch (error) {
    if (error instanceof VerifyCommandError) {
      printResult(false, error.message);
      return;
    }

    throw error;
  }

  const isRevoked = crlClaims.revocations.some(
    (revocation) => revocation.jti === claims.jti,
  );

  if (isRevoked) {
    printResult(false, "revoked");
    return;
  }

  logger.info("cli.verify.success", {
    did: claims.sub,
    jti: claims.jti,
    issuer: claims.iss,
  });
  printResult(true, `token verified (${claims.sub})`);
};

export const createVerifyCommand = (): Command => {
  return new Command("verify")
    .description("Verify an AIT using registry keys and CRL state")
    .argument(
      "<tokenOrFile>",
      "Raw AIT token or file path containing the token",
    )
    .action(
      withErrorHandling("verify", async (tokenOrFile: string) => {
        await runVerify(tokenOrFile);
      }),
    );
};
