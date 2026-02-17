import { RELAY_CONNECT_PATH } from "@clawdentity/protocol";
import { AppError, type Logger } from "@clawdentity/sdk";
import type { Context } from "hono";
import type { AgentRelaySessionNamespace } from "./agent-relay-session.js";
import type { ProxyRequestVariables } from "./auth-middleware.js";

type ProxyContext = Context<{
  Variables: ProxyRequestVariables;
  Bindings: {
    AGENT_RELAY_SESSION?: AgentRelaySessionNamespace;
  };
}>;

export { RELAY_CONNECT_PATH } from "@clawdentity/protocol";

export type RelayConnectRuntimeOptions = {
  resolveSessionNamespace?: (
    c: ProxyContext,
  ) => AgentRelaySessionNamespace | undefined;
};

type CreateRelayConnectHandlerOptions = RelayConnectRuntimeOptions & {
  logger: Logger;
};

const CONNECTOR_AGENT_DID_HEADER = "x-claw-connector-agent-did";

function resolveDefaultNamespace(
  c: ProxyContext,
): AgentRelaySessionNamespace | undefined {
  return c.env.AGENT_RELAY_SESSION;
}

export function createRelayConnectHandler(
  options: CreateRelayConnectHandlerOptions,
): (c: ProxyContext) => Promise<Response> {
  const resolveSessionNamespace =
    options.resolveSessionNamespace ?? resolveDefaultNamespace;

  return async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new AppError({
        code: "PROXY_RELAY_UPGRADE_REQUIRED",
        message: "WebSocket upgrade is required",
        status: 426,
        expose: true,
      });
    }

    const auth = c.get("auth");
    if (auth === undefined) {
      throw new AppError({
        code: "PROXY_RELAY_AUTH_CONTEXT_MISSING",
        message: "Verified auth context is required",
        status: 500,
      });
    }

    const sessionNamespace = resolveSessionNamespace(c);
    if (sessionNamespace === undefined) {
      throw new AppError({
        code: "PROXY_RELAY_UNAVAILABLE",
        message: "Relay session namespace is unavailable",
        status: 503,
      });
    }

    const sessionId = sessionNamespace.idFromName(auth.agentDid);
    const relaySession = sessionNamespace.get(sessionId);

    const relayHeaders = new Headers(c.req.raw.headers);
    relayHeaders.set(CONNECTOR_AGENT_DID_HEADER, auth.agentDid);

    const forwardedRequest = new Request(
      `https://agent-relay-session${RELAY_CONNECT_PATH}`,
      {
        method: "GET",
        headers: relayHeaders,
      },
    );

    const response = await relaySession.fetch(forwardedRequest);
    options.logger.info("proxy.relay.connect", {
      requestId: c.get("requestId"),
      agentDid: auth.agentDid,
      status: response.status,
    });

    return response;
  };
}
