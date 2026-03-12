import { generateUlid, makeAgentDid } from "@clawdentity/protocol";
import { afterEach, vi } from "vitest";

const DID_AUTHORITY = "registry.clawdentity.com";

export class MockWebSocket {
  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];

  private readonly listeners: Record<string, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
    "unexpected-response": new Set(),
  };

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners[type]?.add(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error("socket is not open");
    }

    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return;
    }

    this.readyState = 3;
    this.emit("close", {
      code,
      reason,
      wasClean: true,
    });
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  failClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.emit("close", {
      code,
      reason,
      wasClean: false,
    });
  }

  error(error: unknown): void {
    this.emit("error", { error });
  }

  unexpectedResponse(status: number): void {
    this.emit("unexpected-response", { status });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

export function createAgentDid(seedMs: number): string {
  return makeAgentDid(DID_AUTHORITY, generateUlid(seedMs));
}

export function createMockWebSocketFactory(): {
  sockets: MockWebSocket[];
  webSocketFactory: (url: string) => MockWebSocket;
} {
  const sockets: MockWebSocket[] = [];
  return {
    sockets,
    webSocketFactory: (url: string) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

export function registerConnectorClientTestHooks(): void {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
}
