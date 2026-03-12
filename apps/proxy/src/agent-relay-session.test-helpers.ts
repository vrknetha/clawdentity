import { vi } from "vitest";

export type MockWebSocket = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

export const SENDER_AGENT_DID =
  "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB7";
export const RECIPIENT_AGENT_DID =
  "did:cdi:registry.clawdentity.com:agent:01HF7YAT31JZHSMW1CG6Q6MHB8";
export const RELAY_QUEUE_STORAGE_KEY = "relay:delivery-queue";

export function createMockSocket(): MockWebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

export async function withMockWebSocketPair<T>(
  pairClient: MockWebSocket,
  pairServer: MockWebSocket,
  callback: () => Promise<T>,
): Promise<T> {
  const originalWebSocketPair = (globalThis as { WebSocketPair?: unknown })
    .WebSocketPair;

  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0 = pairClient as unknown as WebSocket;
    1 = pairServer as unknown as WebSocket;
  };

  try {
    return await callback();
  } finally {
    if (originalWebSocketPair === undefined) {
      delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
    } else {
      (globalThis as { WebSocketPair?: unknown }).WebSocketPair =
        originalWebSocketPair;
    }
  }
}

export function createStateHarness() {
  const connectedSockets: WebSocket[] = [];
  const storageMap = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async <T>(key: string) => storageMap.get(key) as T | undefined),
    put: vi.fn(async <T>(key: string, value: T) => {
      storageMap.set(key, value);
    }),
    setAlarm: vi.fn(async (_scheduled: number | Date) => {}),
    deleteAlarm: vi.fn(async () => {}),
  };

  const state = {
    acceptWebSocket: vi.fn((socket: WebSocket) => {
      connectedSockets.push(socket);
    }),
    getWebSockets: vi.fn(() => connectedSockets),
    storage,
  };

  return {
    state,
    storage,
    storageMap,
    connectedSockets,
  };
}
