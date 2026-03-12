import type { ConnectorWebSocket } from "./types.js";

type ConnectorSocketEventHandlers = {
  onOpen: () => void;
  onMessage: (event: unknown) => void;
  onClose: (event: unknown) => void;
  onError: (event: unknown) => void;
  onUnexpectedResponse: (event: unknown) => void;
};

export function attachConnectorSocketEventListeners(
  socket: ConnectorWebSocket,
  handlers: ConnectorSocketEventHandlers,
): void {
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", handlers.onMessage);
  socket.addEventListener("close", handlers.onClose);
  socket.addEventListener("error", handlers.onError);
  socket.addEventListener("unexpected-response", handlers.onUnexpectedResponse);
}
