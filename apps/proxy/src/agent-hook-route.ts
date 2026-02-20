import {
  parseDid,
  parseEncryptedRelayPayloadV1,
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

    let encryptedPayload: ReturnType<typeof parseEncryptedRelayPayloadV1>;
    try {
      encryptedPayload = parseEncryptedRelayPayloadV1(payload);
    } catch {
      throw new AppError({
        code: "PROXY_HOOK_E2EE_REQUIRED",
        message: "Payload must be a valid E2EE envelope",
        status: 400,
        expose: true,
      });
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
      payload: encryptedPayload,
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
