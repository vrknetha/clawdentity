import { randomBytes } from "node:crypto";
import { encodeBase64url } from "@clawdentity/protocol";
import { nowUtcMs, signHttpRequest } from "@clawdentity/sdk";
import { WebSocket as NodeWebSocket } from "ws";
import type { ConnectorWebSocket } from "../client.js";
import { AGENT_ACCESS_HEADER } from "../constants.js";
import { NONCE_SIZE } from "./constants.js";
import { toPathWithQuery } from "./url.js";

export function createWebSocketFactory(): (
  url: string,
  headers: Record<string, string>,
) => ConnectorWebSocket {
  return (url: string, headers: Record<string, string>) => {
    const socket = new NodeWebSocket(url, {
      headers,
    });

    return {
      get readyState() {
        return socket.readyState;
      },
      send: (data: string) => {
        socket.send(data);
      },
      close: (code?: number, reason?: string) => {
        socket.close(code, reason);
      },
      addEventListener: (type, listener) => {
        if (type === "open") {
          socket.on("open", () => listener({}));
          return;
        }

        if (type === "message") {
          socket.on("message", (data) => {
            const text =
              typeof data === "string"
                ? data
                : Array.isArray(data)
                  ? Buffer.concat(data).toString("utf8")
                  : Buffer.isBuffer(data)
                    ? data.toString("utf8")
                    : Buffer.from(data).toString("utf8");
            listener({ data: text });
          });
          return;
        }

        if (type === "close") {
          socket.on("close", (code, reason) => {
            listener({
              code: Number(code),
              reason: reason.toString("utf8"),
              wasClean: Number(code) === 1000,
            });
          });
          return;
        }

        if (type === "unexpected-response") {
          socket.on("unexpected-response", (_request, response) => {
            listener({
              status: response.statusCode,
            });
          });
          return;
        }

        socket.on("error", (error) => listener({ error }));
      },
    };
  };
}

export async function buildUpgradeHeaders(input: {
  ait: string;
  accessToken: string;
  wsUrl: URL;
  secretKey: Uint8Array;
}): Promise<Record<string, string>> {
  const timestamp = Math.floor(nowUtcMs() / 1000).toString();
  const nonce = encodeBase64url(randomBytes(NONCE_SIZE));
  const signed = await signHttpRequest({
    method: "GET",
    pathWithQuery: toPathWithQuery(input.wsUrl),
    timestamp,
    nonce,
    secretKey: input.secretKey,
  });

  return {
    authorization: `Claw ${input.ait}`,
    [AGENT_ACCESS_HEADER]: input.accessToken,
    ...signed.headers,
  };
}
