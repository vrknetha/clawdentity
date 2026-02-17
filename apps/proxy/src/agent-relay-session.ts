import {
  CONNECTOR_FRAME_VERSION,
  DEFAULT_RELAY_DELIVER_TIMEOUT_MS,
  type DeliverFrame,
  type HeartbeatAckFrame,
  parseFrame,
  serializeFrame,
} from "@clawdentity/connector";
import { generateUlid, RELAY_CONNECT_PATH } from "@clawdentity/protocol";

const CONNECTOR_AGENT_DID_HEADER = "x-claw-connector-agent-did";
const RELAY_RPC_DELIVER_PATH = "/rpc/deliver-to-connector";
const RELAY_HEARTBEAT_INTERVAL_MS = 30_000;

type DurableObjectStorageLike = {
  deleteAlarm?: () => Promise<void> | void;
  setAlarm: (scheduledTime: number | Date) => Promise<void> | void;
};

type DurableObjectStateLike = {
  acceptWebSocket: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets: () => WebSocket[];
  storage: DurableObjectStorageLike;
};

export type RelayDeliveryInput = {
  payload: unknown;
  recipientAgentDid: string;
  requestId: string;
  senderAgentDid: string;
};

export type RelayDeliveryResult = {
  connectedSockets: number;
  delivered: boolean;
};

export type AgentRelaySessionStub = {
  deliverToConnector?: (
    input: RelayDeliveryInput,
  ) => Promise<RelayDeliveryResult>;
  fetch: (request: Request) => Promise<Response>;
};

export type AgentRelaySessionNamespace = {
  get: (id: DurableObjectId) => AgentRelaySessionStub;
  idFromName: (name: string) => DurableObjectId;
};

type PendingDelivery = {
  reject: (error: unknown) => void;
  resolve: (accepted: boolean) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

function toHeartbeatFrame(): string {
  return serializeFrame({
    v: CONNECTOR_FRAME_VERSION,
    type: "heartbeat",
    id: generateUlid(Date.now()),
    ts: new Date().toISOString(),
  });
}

function toHeartbeatAckFrame(ackId: string): string {
  const ackFrame: HeartbeatAckFrame = {
    v: CONNECTOR_FRAME_VERSION,
    type: "heartbeat_ack",
    id: generateUlid(Date.now()),
    ts: new Date().toISOString(),
    ackId,
  };

  return serializeFrame(ackFrame);
}

function toDeliverFrame(input: RelayDeliveryInput): DeliverFrame {
  return {
    v: CONNECTOR_FRAME_VERSION,
    type: "deliver",
    id: generateUlid(Date.now()),
    ts: new Date().toISOString(),
    fromAgentDid: input.senderAgentDid,
    toAgentDid: input.recipientAgentDid,
    payload: input.payload,
  };
}

function parseDeliveryInput(value: unknown): RelayDeliveryInput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Relay delivery input must be an object");
  }

  const input = value as Partial<RelayDeliveryInput>;
  if (
    typeof input.requestId !== "string" ||
    typeof input.senderAgentDid !== "string" ||
    typeof input.recipientAgentDid !== "string"
  ) {
    throw new TypeError("Relay delivery input is invalid");
  }

  return {
    requestId: input.requestId,
    senderAgentDid: input.senderAgentDid,
    recipientAgentDid: input.recipientAgentDid,
    payload: input.payload,
  };
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
    throw new Error("Relay session delivery RPC failed");
  }

  return (await response.json()) as RelayDeliveryResult;
}

export class AgentRelaySession {
  private readonly pendingDeliveries = new Map<string, PendingDelivery>();
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === RELAY_CONNECT_PATH) {
      return this.handleConnect(request);
    }

    if (request.method === "POST" && url.pathname === RELAY_RPC_DELIVER_PATH) {
      let input: RelayDeliveryInput;
      try {
        input = parseDeliveryInput(await request.json());
      } catch {
        return new Response("Invalid relay delivery input", { status: 400 });
      }

      try {
        const result = await this.deliverToConnector(input);
        return Response.json(result, { status: 202 });
      } catch {
        return new Response("Relay delivery failed", { status: 502 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return;
    }

    const heartbeatFrame = toHeartbeatFrame();
    for (const socket of sockets) {
      try {
        socket.send(heartbeatFrame);
      } catch {
        try {
          socket.close(1011, "heartbeat_send_failed");
        } catch {
          // Ignore close errors for already-closed sockets.
        }
      }
    }

    await this.scheduleHeartbeat();
  }

  async deliverToConnector(
    input: RelayDeliveryInput,
  ): Promise<RelayDeliveryResult> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return {
        delivered: false,
        connectedSockets: 0,
      };
    }

    const socket = sockets[0];
    const frame = toDeliverFrame(input);
    const framePayload = serializeFrame(frame);

    const accepted = await new Promise<boolean>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingDeliveries.delete(frame.id);
        reject(new Error("Relay connector acknowledgement timed out"));
      }, DEFAULT_RELAY_DELIVER_TIMEOUT_MS);

      this.pendingDeliveries.set(frame.id, {
        resolve,
        reject,
        timeoutHandle,
      });

      try {
        socket.send(framePayload);
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingDeliveries.delete(frame.id);
        reject(error);
      }
    });

    return {
      delivered: accepted,
      connectedSockets: sockets.length,
    };
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const frameResult = (() => {
      try {
        return parseFrame(message);
      } catch {
        return null;
      }
    })();

    if (frameResult === null) {
      await this.scheduleHeartbeat();
      return;
    }

    const frame = frameResult;

    if (frame.type === "heartbeat") {
      ws.send(toHeartbeatAckFrame(frame.id));
      await this.scheduleHeartbeat();
      return;
    }

    if (frame.type === "deliver_ack") {
      const pending = this.pendingDeliveries.get(frame.ackId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingDeliveries.delete(frame.ackId);
        pending.resolve(frame.accepted);
      }
      await this.scheduleHeartbeat();
      return;
    }

    if (frame.type === "heartbeat_ack") {
      await this.scheduleHeartbeat();
      return;
    }

    await this.scheduleHeartbeat();
  }

  async webSocketClose(): Promise<void> {
    if (this.state.getWebSockets().length === 0) {
      await this.state.storage.deleteAlarm?.();
      this.rejectPendingDeliveries(new Error("Connector socket closed"));
      return;
    }

    await this.scheduleHeartbeat();
  }

  async webSocketError(): Promise<void> {
    this.rejectPendingDeliveries(new Error("Connector socket error"));
    await this.webSocketClose();
  }

  private async handleConnect(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }

    const connectorAgentDid =
      request.headers.get(CONNECTOR_AGENT_DID_HEADER)?.trim() ?? "";
    if (connectorAgentDid.length === 0) {
      return new Response("Missing connector agent DID", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server, [connectorAgentDid]);
    await this.scheduleHeartbeat();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private rejectPendingDeliveries(error: Error): void {
    for (const [deliveryId, pending] of this.pendingDeliveries) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingDeliveries.delete(deliveryId);
    }
  }

  private async scheduleHeartbeat(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + RELAY_HEARTBEAT_INTERVAL_MS);
  }
}
