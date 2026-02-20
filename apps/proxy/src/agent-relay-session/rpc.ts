import {
  RELAY_RPC_DELIVER_PATH,
  RELAY_RPC_GET_RECEIPT_PATH,
  RELAY_RPC_RECORD_RECEIPT_PATH,
} from "./constants.js";
import { RelaySessionDeliveryError } from "./errors.js";
import type {
  AgentRelaySessionStub,
  RelayDeliveryInput,
  RelayDeliveryResult,
  RelayReceiptLookupInput,
  RelayReceiptLookupResult,
  RelayReceiptRecordInput,
} from "./types.js";

export function toErrorResponse(input: {
  code: string;
  message: string;
  status: number;
}): Response {
  return Response.json(
    {
      error: {
        code: input.code,
        message: input.message,
      },
    },
    { status: input.status },
  );
}

export async function deliverToRelaySession(
  relaySession: AgentRelaySessionStub,
  input: RelayDeliveryInput,
): Promise<RelayDeliveryResult> {
  const response = await relaySession.fetch(
    new Request(`https://agent-relay-session${RELAY_RPC_DELIVER_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    let code = "PROXY_RELAY_DELIVERY_FAILED";
    let message = "Relay session delivery RPC failed";
    try {
      const body = (await response.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof body.error?.code === "string") {
        code = body.error.code;
      }
      if (typeof body.error?.message === "string") {
        message = body.error.message;
      }
    } catch {
      // Ignore parse failures and keep defaults.
    }

    throw new RelaySessionDeliveryError({
      code,
      message,
      status: response.status,
    });
  }

  return (await response.json()) as RelayDeliveryResult;
}

export async function recordRelayDeliveryReceipt(
  relaySession: AgentRelaySessionStub,
  input: RelayReceiptRecordInput,
): Promise<void> {
  const response = await relaySession.fetch(
    new Request(`https://agent-relay-session${RELAY_RPC_RECORD_RECEIPT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    throw new RelaySessionDeliveryError({
      code: "PROXY_RELAY_RECEIPT_WRITE_FAILED",
      message: "Relay delivery receipt write RPC failed",
      status: response.status,
    });
  }
}

export async function getRelayDeliveryReceipt(
  relaySession: AgentRelaySessionStub,
  input: RelayReceiptLookupInput,
): Promise<RelayReceiptLookupResult> {
  const response = await relaySession.fetch(
    new Request(`https://agent-relay-session${RELAY_RPC_GET_RECEIPT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }),
  );

  if (!response.ok) {
    throw new RelaySessionDeliveryError({
      code: "PROXY_RELAY_RECEIPT_READ_FAILED",
      message: "Relay delivery receipt read RPC failed",
      status: response.status,
    });
  }

  return (await response.json()) as RelayReceiptLookupResult;
}
