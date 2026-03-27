import { randomBytes } from "node:crypto";
import {
  encodeBase64url,
  RELAY_CONVERSATION_ID_HEADER,
  RELAY_DELIVERY_RECEIPT_URL_HEADER,
  RELAY_DELIVERY_RECEIPTS_PATH,
  RELAY_RECIPIENT_AGENT_DID_HEADER,
} from "@clawdentity/protocol";
import {
  type AgentAuthBundle,
  AppError,
  executeWithAgentAuthRefreshRetry,
  nowIso,
  nowUtcMs,
  refreshAgentAuthWithClawProof,
  signHttpRequest,
} from "@clawdentity/sdk";
import { AGENT_ACCESS_HEADER } from "../constants.js";
import { NONCE_SIZE, REFRESH_SINGLE_FLIGHT_PREFIX } from "./constants.js";
import { isRetryableRelayAuthError } from "./errors.js";
import type {
  OutboundDeliveryReceiptStatus,
  OutboundRelayRequest,
} from "./types.js";
import { toPathWithQuery } from "./url.js";

type RelayServiceInput = {
  agentName: string;
  ait: string;
  configDir: string;
  defaultReceiptCallbackUrl: string;
  fetchImpl: typeof fetch;
  getCurrentAuth: () => AgentAuthBundle;
  registryUrl: string;
  secretKey: Uint8Array;
  setCurrentAuth: (nextAuth: AgentAuthBundle) => Promise<void>;
  syncAuthFromDisk: () => Promise<void>;
};

export function createRelayService(input: RelayServiceInput): {
  postDeliveryReceipt: (inputReceipt: {
    reason?: string;
    recipientAgentDid: string;
    requestId: string;
    senderAgentDid: string;
    status: OutboundDeliveryReceiptStatus;
  }) => Promise<void>;
  relayToPeer: (request: OutboundRelayRequest) => Promise<void>;
} {
  const relayToPeer = async (request: OutboundRelayRequest): Promise<void> => {
    await input.syncAuthFromDisk();
    const peerUrl = new URL(request.peerProxyUrl);
    const body = JSON.stringify(request.payload ?? {});
    const refreshKey = `${REFRESH_SINGLE_FLIGHT_PREFIX}:${input.configDir}:${input.agentName}`;

    const performRelay = async (auth: AgentAuthBundle): Promise<void> => {
      // Callback routing authority is the local runtime-owned receipt endpoint.
      const replyTo = input.defaultReceiptCallbackUrl;
      const unixSeconds = Math.floor(nowUtcMs() / 1000).toString();
      const nonce = encodeBase64url(randomBytes(NONCE_SIZE));
      const signed = await signHttpRequest({
        method: "POST",
        pathWithQuery: toPathWithQuery(peerUrl),
        timestamp: unixSeconds,
        nonce,
        body: new TextEncoder().encode(body),
        secretKey: input.secretKey,
      });

      const response = await input.fetchImpl(peerUrl.toString(), {
        method: "POST",
        headers: {
          Authorization: `Claw ${input.ait}`,
          "Content-Type": "application/json",
          [AGENT_ACCESS_HEADER]: auth.accessToken,
          [RELAY_RECIPIENT_AGENT_DID_HEADER]: request.peerDid,
          ...(request.conversationId
            ? { [RELAY_CONVERSATION_ID_HEADER]: request.conversationId }
            : {}),
          [RELAY_DELIVERY_RECEIPT_URL_HEADER]: replyTo,
          ...signed.headers,
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new AppError({
            code: "OPENCLAW_RELAY_AGENT_AUTH_REJECTED",
            message: "Peer relay rejected agent auth credentials",
            status: 401,
            expose: true,
          });
        }

        throw new AppError({
          code: "CONNECTOR_OUTBOUND_DELIVERY_FAILED",
          message: "Peer relay request failed",
          status: 502,
        });
      }
    };

    await executeWithAgentAuthRefreshRetry({
      key: refreshKey,
      shouldRetry: isRetryableRelayAuthError,
      getAuth: async () => {
        await input.syncAuthFromDisk();
        return input.getCurrentAuth();
      },
      persistAuth: async (nextAuth) => {
        await input.setCurrentAuth(nextAuth);
      },
      refreshAuth: async (auth) =>
        refreshAgentAuthWithClawProof({
          registryUrl: input.registryUrl,
          ait: input.ait,
          secretKey: input.secretKey,
          refreshToken: auth.refreshToken,
          fetchImpl: input.fetchImpl,
        }),
      perform: performRelay,
    });
  };

  let ownReceiptUrl: URL;
  try {
    ownReceiptUrl = new URL(input.defaultReceiptCallbackUrl);
  } catch {
    throw new AppError({
      code: "CONNECTOR_DELIVERY_RECEIPT_INVALID_TARGET",
      message: "Delivery receipt callback target is invalid",
      status: 500,
    });
  }

  if (ownReceiptUrl.pathname !== RELAY_DELIVERY_RECEIPTS_PATH) {
    throw new AppError({
      code: "CONNECTOR_DELIVERY_RECEIPT_INVALID_TARGET",
      message: "Delivery receipt callback target is invalid",
      status: 500,
    });
  }

  const postDeliveryReceipt = async (inputReceipt: {
    reason?: string;
    recipientAgentDid: string;
    requestId: string;
    senderAgentDid: string;
    status: OutboundDeliveryReceiptStatus;
  }): Promise<void> => {
    await input.syncAuthFromDisk();

    const body = JSON.stringify({
      requestId: inputReceipt.requestId,
      senderAgentDid: inputReceipt.senderAgentDid,
      recipientAgentDid: inputReceipt.recipientAgentDid,
      status: inputReceipt.status,
      reason: inputReceipt.reason,
      processedAt: nowIso(),
    });
    const refreshKey = `${REFRESH_SINGLE_FLIGHT_PREFIX}:${input.configDir}:${input.agentName}:delivery-receipt`;

    const performReceipt = async (auth: AgentAuthBundle): Promise<void> => {
      const unixSeconds = Math.floor(nowUtcMs() / 1000).toString();
      const nonce = encodeBase64url(randomBytes(NONCE_SIZE));
      const signed = await signHttpRequest({
        method: "POST",
        pathWithQuery: toPathWithQuery(ownReceiptUrl),
        timestamp: unixSeconds,
        nonce,
        body: new TextEncoder().encode(body),
        secretKey: input.secretKey,
      });

      const response = await input.fetchImpl(ownReceiptUrl.toString(), {
        method: "POST",
        headers: {
          Authorization: `Claw ${input.ait}`,
          "Content-Type": "application/json",
          [AGENT_ACCESS_HEADER]: auth.accessToken,
          ...signed.headers,
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new AppError({
            code: "OPENCLAW_RELAY_AGENT_AUTH_REJECTED",
            message:
              "Delivery receipt callback rejected agent auth credentials",
            status: 401,
            expose: true,
          });
        }

        throw new AppError({
          code: "CONNECTOR_DELIVERY_RECEIPT_FAILED",
          message: "Delivery receipt callback request failed",
          status: 502,
        });
      }
    };

    await executeWithAgentAuthRefreshRetry({
      key: refreshKey,
      shouldRetry: isRetryableRelayAuthError,
      getAuth: async () => {
        await input.syncAuthFromDisk();
        return input.getCurrentAuth();
      },
      persistAuth: async (nextAuth) => {
        await input.setCurrentAuth(nextAuth);
      },
      refreshAuth: async (auth) =>
        refreshAgentAuthWithClawProof({
          registryUrl: input.registryUrl,
          ait: input.ait,
          secretKey: input.secretKey,
          refreshToken: auth.refreshToken,
          fetchImpl: input.fetchImpl,
        }),
      perform: performReceipt,
    });
  };

  return {
    relayToPeer,
    postDeliveryReceipt,
  };
}
