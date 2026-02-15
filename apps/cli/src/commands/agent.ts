import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateAgentName } from "@clawdentity/protocol";
import {
  createLogger,
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { getConfigDir, resolveConfig } from "../config/manager.js";
import { writeStdoutLine } from "../io.js";
import { withErrorHandling } from "./helpers.js";

const logger = createLogger({ service: "cli", module: "agent" });

const AGENTS_DIR_NAME = "agents";
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

const assertValidAgentName = (name: string): string => {
  const normalizedName = name.trim();

  if (!validateAgentName(normalizedName)) {
    throw new Error(
      "Agent name contains invalid characters or length. Use 1-64 chars: a-z, A-Z, 0-9, ., _, -",
    );
  }

  return normalizedName;
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

const toRegistryRequestUrl = (registryUrl: string): string => {
  const normalizedBaseUrl = registryUrl.endsWith("/")
    ? registryUrl
    : `${registryUrl}/`;

  return new URL("v1/agents", normalizedBaseUrl).toString();
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

const registerAgent = async (input: {
  apiKey: string;
  registryUrl: string;
  name: string;
  publicKey: string;
  framework?: string;
  ttlDays?: number;
}): Promise<AgentRegistrationResponse> => {
  const requestBody: {
    name: string;
    publicKey: string;
    framework?: string;
    ttlDays?: number;
  } = {
    name: input.name,
    publicKey: input.publicKey,
  };

  if (input.framework) {
    requestBody.framework = input.framework;
  }

  if (input.ttlDays !== undefined) {
    requestBody.ttlDays = input.ttlDays;
  }

  let response: Response;
  try {
    response = await fetch(toRegistryRequestUrl(input.registryUrl), {
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

  return agentCommand;
};
