import {
  createLogger,
  type DecodedAit,
  decodeAIT,
  encodeEd25519KeypairBase64url,
  generateEd25519Keypair,
} from "@clawdentity/sdk";
import { Command } from "commander";
import { resolveConfig } from "../../config/manager.js";
import { writeStdoutLine } from "../../io.js";
import { assertValidAgentName } from "../agent-name.js";
import { withErrorHandling } from "../helpers.js";
import { refreshAgentAuth } from "./auth.js";
import {
  ensureAgentDirectoryAvailable,
  readAgentAitToken,
  readAgentIdentity,
  writeAgentIdentity,
  writeAgentRegistryAuth,
} from "./fs.js";
import { getAgentDirectory } from "./paths.js";
import { registerAgent, revokeAgent } from "./registry.js";
import type { AgentCreateOptions } from "./types.js";
import {
  formatExpiresAt,
  parseAgentIdFromDid,
  resolveFramework,
  resolveTtlDays,
} from "./validation.js";

const logger = createLogger({ service: "cli", module: "agent" });

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
            agentAuth: registration.agentAuth,
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

  const authCommand = new Command("auth").description(
    "Manage local agent registry auth credentials",
  );

  authCommand
    .command("refresh <name>")
    .description("Refresh agent registry auth credentials with Claw proof")
    .action(
      withErrorHandling("agent auth refresh", async (name: string) => {
        const agentName = assertValidAgentName(name);
        const result = await refreshAgentAuth({
          agentName,
        });

        await writeAgentRegistryAuth({
          agentName,
          agentAuth: result.agentAuth,
        });

        logger.info("cli.agent_auth_refreshed", {
          name: agentName,
          registryUrl: result.registryUrl,
          accessExpiresAt: result.agentAuth.accessExpiresAt,
          refreshExpiresAt: result.agentAuth.refreshExpiresAt,
        });

        writeStdoutLine(`Agent auth refreshed: ${agentName}`);
        writeStdoutLine(
          `Access Expires At: ${result.agentAuth.accessExpiresAt}`,
        );
        writeStdoutLine(
          `Refresh Expires At: ${result.agentAuth.refreshExpiresAt}`,
        );
      }),
    );

  agentCommand.addCommand(authCommand);

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
