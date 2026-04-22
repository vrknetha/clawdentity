import { RELAY_DELIVERY_RECEIPTS_PATH } from "@clawdentity/protocol";
import { AppError, type Logger, nowIso } from "@clawdentity/sdk";
import type { Context } from "hono";
import {
  type AgentRelaySessionNamespace,
  getRelayDeliveryReceipt,
  type RelayReceiptRecordInput,
  RelaySessionDeliveryError,
  recordRelayDeliveryReceipt,
} from "./agent-relay-session.js";
import type { ProxyRequestVariables } from "./auth-middleware.js";
import type { ProxyTrustStore } from "./proxy-trust-store.js";
import { DELIVERY_RECEIPT_EVENT_TYPE } from "./queue-consumer/receipt-events.js";
import { assertTrustedPair } from "./trust-policy.js";

export { RELAY_DELIVERY_RECEIPTS_PATH };

type ProxyContext = Context<{
  Variables: ProxyRequestVariables;
  Bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
    ENVIRONMENT?: string;
    RECEIPT_QUEUE?: Queue<string>;
  };
}>;

type CreateRelayDeliveryReceiptHandlersInput = {
  logger: Logger;
  trustStore: ProxyTrustStore;
};

function createRelayReceiptInvalidInputError(): AppError {
  return new AppError({
    code: "PROXY_RELAY_RECEIPT_INVALID_INPUT",
    message: "Relay delivery receipt payload is invalid",
    status: 400,
    expose: true,
  });
}

function parseRecordInput(payload: unknown): RelayReceiptRecordInput {
  if (typeof payload !== "object" || payload === null) {
    throw createRelayReceiptInvalidInputError();
  }

  const input = payload as Partial<RelayReceiptRecordInput>;
  if (
    typeof input.requestId !== "string" ||
    typeof input.senderAgentDid !== "string" ||
    typeof input.recipientAgentDid !== "string" ||
    (input.status !== "delivered_to_webhook" &&
      input.status !== "dead_lettered")
  ) {
    throw createRelayReceiptInvalidInputError();
  }

  const requestId = ensureNonBlank(input.requestId);
  const senderAgentDid = ensureNonBlank(input.senderAgentDid);
  const recipientAgentDid = ensureNonBlank(input.recipientAgentDid);

  return {
    requestId,
    senderAgentDid,
    recipientAgentDid,
    status: input.status,
    reason:
      typeof input.reason === "string" && input.reason.trim().length > 0
        ? input.reason.trim()
        : undefined,
  };
}

function ensureNonBlank(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw createRelayReceiptInvalidInputError();
  }

  return trimmed;
}

function parseRequiredQuery(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError({
      code: "PROXY_RELAY_RECEIPT_INVALID_QUERY",
      message: `Missing query parameter: ${field}`,
      status: 400,
      expose: true,
    });
  }

  return value.trim();
}

function normalizeEnvironment(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveSessionNamespace(c: ProxyContext): AgentRelaySessionNamespace {
  const namespace = c.env.AGENT_RELAY_SESSION;
  if (namespace === undefined) {
    throw new AppError({
      code: "PROXY_RELAY_UNAVAILABLE",
      message: "Relay session namespace is unavailable",
      status: 503,
    });
  }

  return namespace;
}

export function createRelayDeliveryReceiptPostHandler(
  input: CreateRelayDeliveryReceiptHandlersInput,
): (c: ProxyContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get("auth");
    if (!auth) {
      throw new AppError({
        code: "PROXY_RELAY_RECEIPT_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const parsedPayload = parseRecordInput(await c.req.json());
    if (parsedPayload.recipientAgentDid !== auth.agentDid) {
      throw new AppError({
        code: "PROXY_RELAY_RECEIPT_FORBIDDEN",
        message: "Recipient DID does not match authenticated agent",
        status: 403,
        expose: true,
      });
    }

    await assertTrustedPair({
      trustStore: input.trustStore,
      initiatorAgentDid: parsedPayload.senderAgentDid,
      responderAgentDid: parsedPayload.recipientAgentDid,
    });

    const environment = normalizeEnvironment(c.env.ENVIRONMENT);
    const receiptQueue = c.env.RECEIPT_QUEUE;
    if (receiptQueue === undefined) {
      if (environment !== "local") {
        input.logger.warn("proxy.relay.receipt_queue_unavailable", {
          environment: environment ?? "unset",
          fallbackAllowed: false,
        });
        throw new AppError({
          code: "PROXY_RELAY_RECEIPT_QUEUE_UNAVAILABLE",
          message: "Relay delivery receipt queue is unavailable",
          status: 503,
          details: {
            environment: environment ?? "unset",
            fallbackAllowed: false,
          },
        });
      }

      const sessionNamespace = resolveSessionNamespace(c);
      const relaySession = sessionNamespace.get(
        sessionNamespace.idFromName(parsedPayload.senderAgentDid),
      );
      try {
        await recordRelayDeliveryReceipt(relaySession, parsedPayload);
      } catch (error) {
        if (error instanceof RelaySessionDeliveryError) {
          input.logger.warn("proxy.relay.receipt_record_failed", {
            code: error.code,
            status: error.status,
          });
        }
        throw new AppError({
          code: "PROXY_RELAY_RECEIPT_WRITE_FAILED",
          message: "Failed to record relay delivery receipt",
          status: 502,
        });
      }

      return c.json({ accepted: true }, 202);
    }

    try {
      await receiptQueue.send(
        JSON.stringify({
          type: DELIVERY_RECEIPT_EVENT_TYPE,
          requestId: parsedPayload.requestId,
          senderAgentDid: parsedPayload.senderAgentDid,
          recipientAgentDid: parsedPayload.recipientAgentDid,
          status: parsedPayload.status,
          reason: parsedPayload.reason,
          processedAt: nowIso(),
        }),
      );
    } catch (error) {
      input.logger.warn("proxy.relay.receipt_queue_publish_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new AppError({
        code: "PROXY_RELAY_RECEIPT_QUEUE_FAILED",
        message: "Failed to queue relay delivery receipt",
        status: 502,
      });
    }

    return c.json({ accepted: true }, 202);
  };
}

export function createRelayDeliveryReceiptGetHandler(
  input: CreateRelayDeliveryReceiptHandlersInput,
): (c: ProxyContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get("auth");
    if (!auth) {
      throw new AppError({
        code: "PROXY_RELAY_RECEIPT_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const senderAgentDid = auth.agentDid;
    const requestId = parseRequiredQuery(c.req.query("requestId"), "requestId");
    const recipientAgentDid = parseRequiredQuery(
      c.req.query("recipientAgentDid"),
      "recipientAgentDid",
    );

    await assertTrustedPair({
      trustStore: input.trustStore,
      initiatorAgentDid: senderAgentDid,
      responderAgentDid: recipientAgentDid,
    });

    const sessionNamespace = resolveSessionNamespace(c);
    const relaySession = sessionNamespace.get(
      sessionNamespace.idFromName(senderAgentDid),
    );

    try {
      const lookup = await getRelayDeliveryReceipt(relaySession, {
        requestId,
        senderAgentDid,
      });
      if (!lookup.found || lookup.receipt === undefined) {
        return c.json(
          {
            found: false,
          },
          404,
        );
      }

      return c.json(
        {
          found: true,
          receipt: lookup.receipt,
        },
        200,
      );
    } catch (error) {
      if (error instanceof RelaySessionDeliveryError) {
        input.logger.warn("proxy.relay.receipt_lookup_failed", {
          code: error.code,
          status: error.status,
        });
      }
      throw new AppError({
        code: "PROXY_RELAY_RECEIPT_READ_FAILED",
        message: "Failed to read relay delivery receipt",
        status: 502,
      });
    }
  };
}
