import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_DEAD_LETTER_PATH } from "./runtime/constants.js";
import {
  createRuntimeRequestHandler,
  isLoopbackRemoteAddress,
} from "./runtime/server.js";

function createMockRequest(input: {
  method: string;
  remoteAddress?: string;
  url: string;
}): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage;
  Object.assign(request, {
    method: input.method,
    url: input.url,
    socket: {
      remoteAddress: input.remoteAddress,
    },
  });
  return request;
}

function createMockResponse(): {
  json: () => Record<string, unknown>;
  response: ServerResponse;
  statusCode: () => number;
} {
  let body = "";
  const response = {
    statusCode: 200,
    setHeader: () => response,
    end: (chunk?: string) => {
      body = chunk ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  return {
    response,
    statusCode: () =>
      (response as unknown as { statusCode: number }).statusCode,
    json: () => JSON.parse(body.trim()) as Record<string, unknown>,
  };
}

describe("runtime server admin route access", () => {
  it("detects loopback remote addresses", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("203.0.113.8")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });

  it("rejects dead-letter admin access from non-loopback clients", async () => {
    const listDeadLetter = vi.fn(async () => []);
    const handler = createRuntimeRequestHandler({
      connectorClient: {
        getMetricsSnapshot: () =>
          ({
            connection: { connected: true },
            heartbeat: {},
            inboundDelivery: {},
            outboundQueue: {},
          }) as never,
        getQueuedOutboundCount: () => 0,
        isConnected: () => true,
      } as never,
      inboundInbox: {
        listDeadLetter,
      } as never,
      logger: {
        error: () => undefined,
        warn: () => undefined,
      },
      outboundBaseUrl: new URL("http://127.0.0.1:19400/"),
      outboundPath: "/v1/outbound",
      outboundUrl: "http://127.0.0.1:19400/v1/outbound",
      readInboundReplayView: async () =>
        ({
          snapshot: { deadLetter: {}, pending: {} },
          replayerActive: false,
          deliveryWebhookGateway: {
            reachable: true,
            url: "http://127.0.0.1:18789",
          },
          deliveryWebhookHook: { url: "http://127.0.0.1:18789/hooks/message" },
        }) as never,
      relayToPeer: async () => undefined,
      replayPendingInboundMessages: () => undefined,
      wsUrl: "ws://127.0.0.1:1337/v1/relay/connect",
    });
    const request = createMockRequest({
      method: "GET",
      remoteAddress: "203.0.113.8",
      url: CONNECTOR_DEAD_LETTER_PATH,
    });
    const response = createMockResponse();

    await handler(request, response.response);

    expect(response.statusCode()).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "CONNECTOR_ADMIN_FORBIDDEN",
        message:
          "Dead-letter admin endpoints are restricted to loopback clients",
      },
    });
    expect(listDeadLetter).not.toHaveBeenCalled();
  });

  it("allows dead-letter admin access from loopback clients", async () => {
    const listDeadLetter = vi.fn(async () => []);
    const handler = createRuntimeRequestHandler({
      connectorClient: {
        getMetricsSnapshot: () =>
          ({
            connection: { connected: true },
            heartbeat: {},
            inboundDelivery: {},
            outboundQueue: {},
          }) as never,
        getQueuedOutboundCount: () => 0,
        isConnected: () => true,
      } as never,
      inboundInbox: {
        listDeadLetter,
      } as never,
      logger: {
        error: () => undefined,
        warn: () => undefined,
      },
      outboundBaseUrl: new URL("http://127.0.0.1:19400/"),
      outboundPath: "/v1/outbound",
      outboundUrl: "http://127.0.0.1:19400/v1/outbound",
      readInboundReplayView: async () =>
        ({
          snapshot: { deadLetter: {}, pending: {} },
          replayerActive: false,
          deliveryWebhookGateway: {
            reachable: true,
            url: "http://127.0.0.1:18789",
          },
          deliveryWebhookHook: { url: "http://127.0.0.1:18789/hooks/message" },
        }) as never,
      relayToPeer: async () => undefined,
      replayPendingInboundMessages: () => undefined,
      wsUrl: "ws://127.0.0.1:1337/v1/relay/connect",
    });
    const request = createMockRequest({
      method: "GET",
      remoteAddress: "::1",
      url: CONNECTOR_DEAD_LETTER_PATH,
    });
    const response = createMockResponse();

    await handler(request, response.response);

    expect(response.statusCode()).toBe(200);
    expect(listDeadLetter).toHaveBeenCalledTimes(1);
  });
});
