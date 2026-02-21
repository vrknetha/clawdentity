import type { IncomingMessage, ServerResponse } from "node:http";
import { AppError } from "@clawdentity/sdk";
import { MAX_OUTBOUND_BODY_BYTES } from "./constants.js";
import { isRecord, parseOptionalString, parseRequiredString } from "./parse.js";
import type { OutboundRelayRequest } from "./types.js";

export async function readRequestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    totalBytes += next.length;
    if (totalBytes > MAX_OUTBOUND_BODY_BYTES) {
      throw new AppError({
        code: "CONNECTOR_OUTBOUND_TOO_LARGE",
        message: "Outbound relay payload too large",
        status: 413,
        expose: true,
      });
    }
    chunks.push(next);
  }

  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (bodyText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new AppError({
      code: "CONNECTOR_OUTBOUND_INVALID_JSON",
      message: "Outbound relay payload must be valid JSON",
      status: 400,
      expose: true,
    });
  }
}

export function parseOutboundRelayRequest(
  payload: unknown,
): OutboundRelayRequest {
  if (!isRecord(payload)) {
    throw new AppError({
      code: "CONNECTOR_OUTBOUND_INVALID_REQUEST",
      message: "Outbound relay request must be an object",
      status: 400,
      expose: true,
    });
  }

  const replyTo = parseOptionalString(payload.replyTo);
  if (replyTo !== undefined) {
    try {
      new URL(replyTo);
    } catch {
      throw new AppError({
        code: "CONNECTOR_OUTBOUND_INVALID_REQUEST",
        message: "Outbound relay replyTo must be a valid URL",
        status: 400,
        expose: true,
      });
    }
  }

  return {
    peer: parseRequiredString(payload.peer, "peer"),
    peerDid: parseRequiredString(payload.peerDid, "peerDid"),
    peerProxyUrl: parseRequiredString(payload.peerProxyUrl, "peerProxyUrl"),
    payload: payload.payload,
    conversationId: parseOptionalString(payload.conversationId),
    replyTo,
  };
}

export function writeJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}
