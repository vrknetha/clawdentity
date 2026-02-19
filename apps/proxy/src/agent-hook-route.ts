import {
  parseDid,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
} from "@clawdentity/protocol";
import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import {
  type AgentRelaySessionNamespace,
  deliverToRelaySession,
  type RelayDeliveryInput,
  RelaySessionDeliveryError,
} from "./agent-relay-session.js";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import type { ProxyTrustStore } from "./proxy-trust-store.js";
import { assertTrustedPair } from "./trust-policy.js";

const MAX_AGENT_DID_LENGTH = 160;
const MAX_OWNER_DID_LENGTH = 160;
const MAX_ISSUER_LENGTH = 200;
const MAX_AIT_JTI_LENGTH = 64;

export { RELAY_RECIPIENT_AGENT_DID_HEADER } from "@clawdentity/protocol";

export type AgentHookRuntimeOptions = {
  injectIdentityIntoMessage?: boolean;
  now?: () => Date;
  resolveSessionNamespace?: (
    c: ProxyContext,
  ) => AgentRelaySessionNamespace | undefined;
};

type CreateAgentHookHandlerOptions = AgentHookRuntimeOptions & {
  logger: Logger;
  trustStore: ProxyTrustStore;
};

type ProxyContext = Context<{
  Variables: ProxyRequestVariables;
  Bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  };
}>;

function isJsonContentType(contentTypeHeader: string | undefined): boolean {
  if (typeof contentTypeHeader !== "string") {
    return false;
  }

  const [mediaType] = contentTypeHeader.split(";");
  return mediaType.trim().toLowerCase() === "application/json";
}

function stripControlChars(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }
    result += char;
  }

  return result;
}

function sanitizeIdentityField(value: string, maxLength: number): string {
  const sanitized = stripControlChars(value).replaceAll(/\s+/g, " ").trim();

  if (sanitized.length === 0) {
    return "unknown";
  }

  return sanitized.slice(0, maxLength);
}

function buildIdentityBlock(
  auth: NonNullable<ProxyRequestVariables["auth"]>,
): string {
  return [
    "[Clawdentity Identity]",
    `agentDid: ${sanitizeIdentityField(auth.agentDid, MAX_AGENT_DID_LENGTH)}`,
    `ownerDid: ${sanitizeIdentityField(auth.ownerDid, MAX_OWNER_DID_LENGTH)}`,
    `issuer: ${sanitizeIdentityField(auth.issuer, MAX_ISSUER_LENGTH)}`,
    `aitJti: ${sanitizeIdentityField(auth.aitJti, MAX_AIT_JTI_LENGTH)}`,
  ].join("\n");
}

function injectIdentityBlockIntoPayload(
  payload: unknown,
  auth: ProxyRequestVariables["auth"],
): unknown {
  if (auth === undefined || typeof payload !== "object" || payload === null) {
    return payload;
  }

  if (!("message" in payload)) {
    return payload;
  }

  const message = (payload as { message?: unknown }).message;
  if (typeof message !== "string") {
    return payload;
  }

  return {
    ...(payload as Record<string, unknown>),
    message: `${buildIdentityBlock(auth)}\n\n${message}`,
  };
}

function parseRecipientAgentDid(c: ProxyContext): string {
  const recipientHeader = c.req.header(RELAY_RECIPIENT_AGENT_DID_HEADER);
  if (
    typeof recipientHeader !== "string" ||
    recipientHeader.trim().length === 0
  ) {
    throw new AppError({
      code: "PROXY_HOOK_RECIPIENT_REQUIRED",
      message: "X-Claw-Recipient-Agent-Did header is required",
      status: 400,
      expose: true,
    });
  }

  const recipientDid = recipientHeader.trim();
  let parsedDid: ReturnType<typeof parseDid>;
  try {
    parsedDid = parseDid(recipientDid);
  } catch {
    throw new AppError({
      code: "PROXY_HOOK_RECIPIENT_INVALID",
      message: "X-Claw-Recipient-Agent-Did must be a valid agent DID",
      status: 400,
      expose: true,
    });
  }

  if (parsedDid.kind !== "agent") {
    throw new AppError({
      code: "PROXY_HOOK_RECIPIENT_INVALID",
      message: "X-Claw-Recipient-Agent-Did must be a valid agent DID",
      status: 400,
      expose: true,
    });
  }

  return recipientDid;
}

function resolveDefaultSessionNamespace(
  c: ProxyContext,
): AgentRelaySessionNamespace | undefined {
  return c.env.AGENT_RELAY_SESSION;
}

export function createAgentHookHandler(
  options: CreateAgentHookHandlerOptions,
): (c: ProxyContext) => Promise<Response> {
  const injectIdentityIntoMessage = options.injectIdentityIntoMessage ?? false;
  const now = options.now ?? (() => new Date());
  const resolveSessionNamespace =
    options.resolveSessionNamespace ?? resolveDefaultSessionNamespace;

  return async (c) => {
    if (!isJsonContentType(c.req.header("content-type"))) {
      throw new AppError({
        code: "PROXY_HOOK_UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json",
        status: 415,
        expose: true,
      });
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      throw new AppError({
        code: "PROXY_HOOK_INVALID_JSON",
        message: "Request body must be valid JSON",
        status: 400,
        expose: true,
      });
    }

    if (injectIdentityIntoMessage) {
      payload = injectIdentityBlockIntoPayload(payload, c.get("auth"));
    }

    const auth = c.get("auth");
    if (auth === undefined) {
      throw new AppError({
        code: "PROXY_HOOK_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const recipientAgentDid = parseRecipientAgentDid(c);
    await assertTrustedPair({
      trustStore: options.trustStore,
      initiatorAgentDid: auth.agentDid,
      responderAgentDid: recipientAgentDid,
    });

    const sessionNamespace = resolveSessionNamespace(c);
    if (sessionNamespace === undefined) {
      throw new AppError({
        code: "PROXY_RELAY_UNAVAILABLE",
        message: "Relay session namespace is unavailable",
        status: 503,
      });
    }

    const requestId = c.get("requestId");
    const relayInput: RelayDeliveryInput = {
      requestId,
      senderAgentDid: auth.agentDid,
      recipientAgentDid,
      payload,
    };

    const relaySession = sessionNamespace.get(
      sessionNamespace.idFromName(recipientAgentDid),
    );

    let deliveryResult: Awaited<ReturnType<typeof deliverToRelaySession>>;
    try {
      deliveryResult = await deliverToRelaySession(relaySession, relayInput);
    } catch (error) {
      if (
        error instanceof RelaySessionDeliveryError &&
        error.code === "PROXY_RELAY_QUEUE_FULL"
      ) {
        options.logger.warn("proxy.hooks.agent.relay_queue_full", {
          requestId,
          senderAgentDid: auth.agentDid,
          recipientAgentDid,
        });

        throw new AppError({
          code: "PROXY_RELAY_QUEUE_FULL",
          message: "Target relay queue is full",
          status: 507,
          expose: true,
        });
      }

      options.logger.warn("proxy.hooks.agent.relay_delivery_failed", {
        requestId,
        senderAgentDid: auth.agentDid,
        recipientAgentDid,
        errorName: error instanceof Error ? error.name : "unknown",
      });

      throw new AppError({
        code: "PROXY_RELAY_DELIVERY_FAILED",
        message: "Relay delivery failed",
        status: 502,
      });
    }

    const delivered = deliveryResult.delivered;
    const queued = deliveryResult.queued ?? !delivered;
    const state = deliveryResult.state ?? (delivered ? "delivered" : "queued");
    const queueDepth = deliveryResult.queueDepth ?? (queued ? 1 : 0);
    const deliveryId = deliveryResult.deliveryId ?? requestId;
    const connectedSockets = deliveryResult.connectedSockets;

    options.logger.info("proxy.hooks.agent.delivered_to_relay", {
      requestId,
      senderAgentDid: auth.agentDid,
      recipientAgentDid,
      deliveryId,
      state,
      delivered,
      queued,
      queueDepth,
      connectedSockets,
      sentAt: now().toISOString(),
    });

    return c.json(
      {
        accepted: true,
        deliveryId,
        state,
        delivered,
        queued,
        queueDepth,
        connectedSockets,
      },
      202,
    );
  };
}
