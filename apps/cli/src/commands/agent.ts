import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_REGISTRATION_CHALLENGE_PATH,
  canonicalizeAgentRegistrationProof,
  parseDid,
} from "@clawdentity/protocol";
import {
  createLogger,
  type DecodedAit,
  decodeAIT,
  encodeEd25519KeypairBase64url,
  encodeEd25519SignatureBase64url,
  generateEd25519Keypair,
  signEd25519,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { getConfigDir, resolveConfig } from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { assertValidAgentName } from "./agent-name.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "agent" });

const AGENTS_DIR_NAME = "agents";
const AIT_FILE_NAME = "ait.jwt";
const IDENTITY_FILE_NAME = "identity.json";
const FILE_MODE = 0o600;

type AgentCreateOptions = {
  framework?: string;
  ttlDays?: string;
};

type AgentRegistrationResponse = {
  agent: {
    did: string;
    name: string;
    framework: string;
    expiresAt: string;
  };
  ait: string;
};

type AgentRegistrationChallengeResponse = {
  challengeId: string;
  nonce: string;
  ownerDid: string;
  expiresAt: string;
};

type LocalAgentIdentity = {
  did: string;
};

type RegistryErrorEnvelope = {
  error?: {
    message?: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const getAgentDirectory = (name: string): string => {
  return join(getConfigDir(), AGENTS_DIR_NAME, name);
};

const getAgentAitPath = (name: string): string => {
  return join(getAgentDirectory(name), AIT_FILE_NAME);
};

const getAgentIdentityPath = (name: string): string => {
  return join(getAgentDirectory(name), IDENTITY_FILE_NAME);
};

const readAgentAitToken = async (agentName: string): Promise<string> => {
  const aitPath = getAgentAitPath(agentName);

  let rawToken: string;
  try {
    rawToken = await readFile(aitPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Agent "${agentName}" not found (${aitPath})`);
    }

    throw error;
  }

  const token = rawToken.trim();
  if (token.length === 0) {
    throw new Error(`Agent "${agentName}" has an empty ${AIT_FILE_NAME}`);
  }

  return token;
};

const readAgentIdentity = async (
  agentName: string,
): Promise<LocalAgentIdentity> => {
  const identityPath = getAgentIdentityPath(agentName);

  let rawIdentity: string;
  try {
    rawIdentity = await readFile(identityPath, "utf-8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new Error(`Agent "${agentName}" not found (${identityPath})`);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawIdentity);
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (must be valid JSON)`,
    );
  }

  if (!isRecord(parsed) || typeof parsed.did !== "string") {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (missing did)`,
    );
  }

  const did = parsed.did.trim();
  if (did.length === 0) {
    throw new Error(
      `Agent "${agentName}" has invalid ${IDENTITY_FILE_NAME} (missing did)`,
    );
  }

  return { did };
};

const parseAgentIdFromDid = (agentName: string, did: string): string => {
  try {
    const parsedDid = parseDid(did);
    if (parsedDid.kind !== "agent") {
      throw new Error("DID is not an agent DID");
    }

    return parsedDid.ulid;
  } catch {
    throw new Error(
      `Agent "${agentName}" has invalid did in ${IDENTITY_FILE_NAME}: ${did}`,
    );
  }
};

const formatExpiresAt = (expires: number): string => {
  return new Date(expires * 1000).toISOString();
};

const resolveFramework = (
  framework: string | undefined,
): string | undefined => {
  if (framework === undefined) {
    return undefined;
  }

  const normalizedFramework = framework.trim();
  if (normalizedFramework.length === 0) {
    throw new Error("--framework must not be empty when provided");
  }

  return normalizedFramework;
};

const resolveTtlDays = (ttlDays: string | undefined): number | undefined => {
  if (ttlDays === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(ttlDays, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--ttl-days must be a positive integer");
  }

  return parsed;
};

const extractRegistryErrorMessage = (payload: unknown): string | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }

  const envelope = payload as RegistryErrorEnvelope;
  if (!envelope.error || typeof envelope.error.message !== "string") {
    return undefined;
  }

  const trimmed = envelope.error.message.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseJsonResponse = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const toRegistryAgentsRequestUrl = (
  registryUrl: string,
  agentId?: string,
): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  const path = agentId
    ? `v1/agents/${encodeURIComponent(agentId)}`
    : "v1/agents";

  return new URL(path, normalizedBaseUrl).toString();
};

const toRegistryAgentChallengeRequestUrl = (registryUrl: string): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  return new URL(
    AGENT_REGISTRATION_CHALLENGE_PATH.slice(1),
    normalizedBaseUrl,
  ).toString();
};

const toHttpErrorMessage = (status: number, responseBody: unknown): string => {
  const registryMessage = extractRegistryErrorMessage(responseBody);

  if (status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (status === 400) {
    return registryMessage
      ? `Registry rejected the request (400): ${registryMessage}`
      : "Registry rejected the request (400). Check name/framework/ttl-days.";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry request failed (${status}): ${registryMessage}`;
  }

  return `Registry request failed (${status})`;
};

const parseAgentRegistrationResponse = (
  payload: unknown,
): AgentRegistrationResponse => {
  if (!isRecord(payload)) {
    throw new Error("Registry returned an invalid response payload");
  }

  const agentValue = payload.agent;
  const aitValue = payload.ait;

  if (!isRecord(agentValue) || typeof aitValue !== "string") {
    throw new Error("Registry returned an invalid response payload");
  }

  const did = agentValue.did;
  const name = agentValue.name;
  const framework = agentValue.framework;
  const expiresAt = agentValue.expiresAt;

  if (
    typeof did !== "string" ||
    typeof name !== "string" ||
    typeof framework !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  return {
    agent: {
      did,
      name,
      framework,
      expiresAt,
    },
    ait: aitValue,
  };
};

const parseAgentRegistrationChallengeResponse = (
  payload: unknown,
): AgentRegistrationChallengeResponse => {
  if (!isRecord(payload)) {
    throw new Error("Registry returned an invalid response payload");
  }

  const challengeId = payload.challengeId;
  const nonce = payload.nonce;
  const ownerDid = payload.ownerDid;
  const expiresAt = payload.expiresAt;

  if (
    typeof challengeId !== "string" ||
    typeof nonce !== "string" ||
    typeof ownerDid !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new Error("Registry returned an invalid response payload");
  }

  return {
    challengeId,
    nonce,
    ownerDid,
    expiresAt,
  };
};

const ensureAgentDirectoryAvailable = async (
  agentName: string,
  agentDirectory: string,
): Promise<void> => {
  try {
    await access(agentDirectory);
    throw new Error(`Agent "${agentName}" already exists at ${agentDirectory}`);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }

    throw error;
  }
};

const writeSecureFile = async (
  path: string,
  content: string,
): Promise<void> => {
  await writeFile(path, content, "utf-8");
  await chmod(path, FILE_MODE);
};

const ensureAgentDirectory = async (
  agentName: string,
  agentDirectory: string,
): Promise<void> => {
  await mkdir(join(getConfigDir(), AGENTS_DIR_NAME), { recursive: true });

  try {
    await mkdir(agentDirectory);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "EEXIST") {
      throw new Error(
        `Agent "${agentName}" already exists at ${agentDirectory}`,
      );
    }

    throw error;
  }
};

const writeAgentIdentity = async (input: {
  agentDirectory: string;
  did: string;
  name: string;
  framework: string;
  expiresAt: string;
  registryUrl: string;
  publicKey: string;
  secretKey: string;
  ait: string;
}): Promise<void> => {
  await ensureAgentDirectory(input.name, input.agentDirectory);

  const identityJson = {
    did: input.did,
    name: input.name,
    framework: input.framework,
    expiresAt: input.expiresAt,
    registryUrl: input.registryUrl,
  };

  await writeSecureFile(
    join(input.agentDirectory, "secret.key"),
    input.secretKey,
  );
  await writeSecureFile(
    join(input.agentDirectory, "public.key"),
    input.publicKey,
  );
  await writeSecureFile(
    join(input.agentDirectory, "identity.json"),
    `${JSON.stringify(identityJson, null, 2)}\n`,
  );
  await writeSecureFile(join(input.agentDirectory, "ait.jwt"), input.ait);
};

const requestAgentRegistrationChallenge = async (input: {
  apiKey: string;
  registryUrl: string;
  publicKey: string;
}): Promise<AgentRegistrationChallengeResponse> => {
  let response: Response;
  try {
    response = await fetch(
      toRegistryAgentChallengeRequestUrl(input.registryUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          publicKey: input.publicKey,
        }),
      },
    );
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toHttpErrorMessage(response.status, responseBody));
  }

  return parseAgentRegistrationChallengeResponse(responseBody);
};

const registerAgent = async (input: {
  apiKey: string;
  registryUrl: string;
  name: string;
  publicKey: string;
  secretKey: Uint8Array;
  framework?: string;
  ttlDays?: number;
}): Promise<AgentRegistrationResponse> => {
  const challenge = await requestAgentRegistrationChallenge({
    apiKey: input.apiKey,
    registryUrl: input.registryUrl,
    publicKey: input.publicKey,
  });

  const canonicalProof = canonicalizeAgentRegistrationProof({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    ownerDid: challenge.ownerDid,
    publicKey: input.publicKey,
    name: input.name,
    framework: input.framework,
    ttlDays: input.ttlDays,
  });
  const challengeSignature = encodeEd25519SignatureBase64url(
    await signEd25519(
      new TextEncoder().encode(canonicalProof),
      input.secretKey,
    ),
  );

  const requestBody: {
    name: string;
    publicKey: string;
    challengeId: string;
    challengeSignature: string;
    framework?: string;
    ttlDays?: number;
  } = {
    name: input.name,
    publicKey: input.publicKey,
    challengeId: challenge.challengeId,
    challengeSignature,
  };

  if (input.framework) {
    requestBody.framework = input.framework;
  }

  if (input.ttlDays !== undefined) {
    requestBody.ttlDays = input.ttlDays;
  }

  let response: Response;
  try {
    response = await fetch(toRegistryAgentsRequestUrl(input.registryUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toHttpErrorMessage(response.status, responseBody));
  }

  return parseAgentRegistrationResponse(responseBody);
};

const toRevokeHttpErrorMessage = (
  status: number,
  responseBody: unknown,
): string => {
  const registryMessage = extractRegistryErrorMessage(responseBody);

  if (status === 401) {
    return registryMessage
      ? `Registry authentication failed (401): ${registryMessage}`
      : "Registry authentication failed (401). Check your API key.";
  }

  if (status === 404) {
    return registryMessage
      ? `Agent not found (404): ${registryMessage}`
      : "Agent not found in the registry (404).";
  }

  if (status === 409) {
    return registryMessage
      ? `Agent cannot be revoked (409): ${registryMessage}`
      : "Agent cannot be revoked (409).";
  }

  if (status >= 500) {
    return `Registry server error (${status}). Try again later.`;
  }

  if (registryMessage) {
    return `Registry request failed (${status}): ${registryMessage}`;
  }

  return `Registry request failed (${status})`;
};

const revokeAgent = async (input: {
  apiKey: string;
  registryUrl: string;
  agentId: string;
}): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(
      toRegistryAgentsRequestUrl(input.registryUrl, input.agentId),
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
        },
      },
    );
  } catch {
    throw new Error(
      "Unable to connect to the registry. Check network access and registryUrl.",
    );
  }

  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    throw new Error(toRevokeHttpErrorMessage(response.status, responseBody));
  }
};

const printAgentInspect = (decoded: DecodedAit): void => {
  writeStdoutLine(`DID: ${decoded.claims.sub}`);
  writeStdoutLine(`Owner: ${decoded.claims.ownerDid}`);
  writeStdoutLine(`Expires: ${formatExpiresAt(decoded.claims.exp)}`);
  writeStdoutLine(`Key ID: ${decoded.header.kid}`);
  writeStdoutLine(`Public Key: ${decoded.claims.cnf.jwk.x}`);
  writeStdoutLine(`Framework: ${decoded.claims.framework}`);
};

const printAgentInspectCommand = async (name: string): Promise<void> => {
  const normalizedName = assertValidAgentName(name);
  const aitToken = await readAgentAitToken(normalizedName);
  const decoded = decodeAIT(aitToken);

  printAgentInspect(decoded);
};

export const createAgentCommand = (): Command => {
  const agentCommand = new Command("agent").description(
    "Manage local agent identities",
  );

  agentCommand
    .command("create <name>")
    .description("Generate and register a new agent identity")
    .option(
      "--framework <framework>",
      "Agent framework label (registry defaults to openclaw)",
    )
    .option(
      "--ttl-days <days>",
      "Agent token TTL in days (registry default when omitted)",
    )
    .action(
      withErrorHandling(
        "agent create",
        async (name: string, options: AgentCreateOptions) => {
          const config = await resolveConfig();
          if (!config.apiKey) {
            throw new Error(
              "API key is not configured. Run `clawdentity config set apiKey <token>` or set CLAWDENTITY_API_KEY.",
            );
          }

          const agentName = assertValidAgentName(name);
          const framework = resolveFramework(options.framework);
          const ttlDays = resolveTtlDays(options.ttlDays);
          const agentDirectory = getAgentDirectory(agentName);

          await ensureAgentDirectoryAvailable(agentName, agentDirectory);

          const keypair = await generateEd25519Keypair();
          const encoded = encodeEd25519KeypairBase64url(keypair);
          const registration = await registerAgent({
            apiKey: config.apiKey,
            registryUrl: config.registryUrl,
            name: agentName,
            publicKey: encoded.publicKey,
            secretKey: keypair.secretKey,
            framework,
            ttlDays,
          });

          await writeAgentIdentity({
            agentDirectory,
            did: registration.agent.did,
            name: registration.agent.name,
            framework: registration.agent.framework,
            expiresAt: registration.agent.expiresAt,
            registryUrl: config.registryUrl,
            publicKey: encoded.publicKey,
            secretKey: encoded.secretKey,
            ait: registration.ait,
          });

          logger.info("cli.agent_created", {
            name: registration.agent.name,
            did: registration.agent.did,
            agentDirectory,
            registryUrl: config.registryUrl,
            expiresAt: registration.agent.expiresAt,
          });

          writeStdoutLine(`Agent DID: ${registration.agent.did}`);
          writeStdoutLine(`Expires At: ${registration.agent.expiresAt}`);
        },
      ),
    );

  agentCommand
    .command("inspect <name>")
    .description("Decode and show metadata from an agent's stored AIT")
    .action(
      withErrorHandling("agent inspect", async (name: string) => {
        await printAgentInspectCommand(name);
      }),
    );

  agentCommand
    .command("revoke <name>")
    .description("Revoke a local agent identity via the registry")
    .action(
      withErrorHandling("agent revoke", async (name: string) => {
        const config = await resolveConfig();
        if (!config.apiKey) {
          throw new Error(
            "API key is not configured. Run `clawdentity config set apiKey <token>` or set CLAWDENTITY_API_KEY.",
          );
        }

        const agentName = assertValidAgentName(name);
        const identity = await readAgentIdentity(agentName);
        const agentId = parseAgentIdFromDid(agentName, identity.did);

        await revokeAgent({
          apiKey: config.apiKey,
          registryUrl: config.registryUrl,
          agentId,
        });

        logger.info("cli.agent_revoked", {
          name: agentName,
          did: identity.did,
          agentId,
          registryUrl: config.registryUrl,
        });

        writeStdoutLine(`Agent revoked: ${agentName} (${identity.did})`);
        writeStdoutLine("CRL visibility depends on verifier refresh interval.");
      }),
    );

  return agentCommand;
};
