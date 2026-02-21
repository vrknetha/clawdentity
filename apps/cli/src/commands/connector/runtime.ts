import { startConnectorRuntime as bundledStartConnectorRuntime } from "@clawdentity/connector";
import type { ConnectorModule, ConnectorRuntime } from "./types.js";
import { isRecord } from "./validation.js";

export async function loadDefaultConnectorModule(): Promise<ConnectorModule> {
  return {
    startConnectorRuntime: bundledStartConnectorRuntime,
  };
}

export function resolveWaitPromise(
  runtime: ConnectorRuntime | undefined,
): Promise<void> | undefined {
  if (!runtime || !isRecord(runtime)) {
    return undefined;
  }

  if (typeof runtime.waitUntilStopped === "function") {
    return runtime.waitUntilStopped();
  }

  if (typeof runtime.waitForStop === "function") {
    return runtime.waitForStop();
  }

  if (runtime.closed instanceof Promise) {
    return runtime.closed.then(() => undefined);
  }

  return undefined;
}

export function resolveRuntimeOutboundUrl(
  runtime: ConnectorRuntime | undefined,
  fallbackOutboundUrl: string,
): string {
  if (runtime && isRecord(runtime) && typeof runtime.outboundUrl === "string") {
    return runtime.outboundUrl;
  }

  return fallbackOutboundUrl;
}

export function resolveRuntimeProxyWebsocketUrl(
  runtime: ConnectorRuntime | undefined,
  fallbackProxyWebsocketUrl: string,
): string | undefined {
  if (!runtime || !isRecord(runtime)) {
    return undefined;
  }

  if (typeof runtime.websocketUrl === "string") {
    return runtime.websocketUrl;
  }

  if (typeof runtime.proxyWebsocketUrl === "string") {
    return runtime.proxyWebsocketUrl;
  }

  return fallbackProxyWebsocketUrl;
}
