import {
  generateUlid,
  makeAgentDid,
  makeHumanDid,
} from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import {
  ConnectorFrameParseError,
  parseFrame,
  serializeFrame,
} from "./frames.js";

const DID_AUTHORITY = "registry.example.test";

function createAgentDid(seedMs: number): string {
  return makeAgentDid(DID_AUTHORITY, generateUlid(seedMs));
}

describe("connector frame parsing", () => {
  it("roundtrips a valid enqueue frame", () => {
    const frame = {
      v: 1 as const,
      type: "enqueue" as const,
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
      toAgentDid: createAgentDid(1700000000100),
      payload: {
        message: "hello",
      },
      conversationId: "conv_123",
      replyTo: "https://example.com/hooks/agent",
    };

    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);

    expect(parsed).toEqual(frame);
  });

  it("roundtrips enqueue and deliver frames with groupId", () => {
    const groupId = "grp_01HF7YAT31JZHSMW1CG6Q6MHB7";
    const enqueueFrame = {
      v: 1 as const,
      type: "enqueue" as const,
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
      toAgentDid: createAgentDid(1700000000100),
      groupId,
      payload: {
        message: "hello-group",
      },
    };

    expect(parseFrame(serializeFrame(enqueueFrame))).toEqual(enqueueFrame);

    const deliverFrame = {
      v: 1 as const,
      type: "deliver" as const,
      id: generateUlid(1700000000200),
      ts: "2026-01-01T00:00:00.000Z",
      fromAgentDid: createAgentDid(1700000000300),
      toAgentDid: createAgentDid(1700000000400),
      groupId,
      payload: { message: "fanout" },
    };

    expect(parseFrame(serializeFrame(deliverFrame))).toEqual(deliverFrame);
  });

  it("roundtrips a deliver frame with delivery source metadata", () => {
    const frame = {
      v: 1 as const,
      type: "deliver" as const,
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
      fromAgentDid: createAgentDid(1700000000100),
      toAgentDid: createAgentDid(1700000000200),
      payload: { system: { type: "pair.accepted" } },
      deliverySource: "proxy.events.queue.pair_accepted",
    };

    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);

    expect(parsed).toEqual(frame);
  });

  it("parses binary frame payloads", () => {
    const heartbeat = {
      v: 1 as const,
      type: "heartbeat" as const,
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
    };

    const raw = new TextEncoder().encode(JSON.stringify(heartbeat));

    expect(parseFrame(raw)).toEqual(heartbeat);
  });

  it("throws INVALID_JSON on malformed json", () => {
    expect(() => parseFrame("{not json")).toThrowError(
      ConnectorFrameParseError,
    );

    try {
      parseFrame("{not json");
      throw new Error("expected parseFrame to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorFrameParseError);
      expect((error as ConnectorFrameParseError).code).toBe("INVALID_JSON");
    }
  });

  it("throws INVALID_FRAME on invalid shape", () => {
    const invalid = {
      v: 1,
      type: "enqueue",
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
      toAgentDid: makeHumanDid(DID_AUTHORITY, generateUlid(1700000000100)),
      payload: {
        message: "hello",
      },
    };

    try {
      parseFrame(invalid);
      throw new Error("expected parseFrame to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorFrameParseError);
      expect((error as ConnectorFrameParseError).code).toBe("INVALID_FRAME");
    }
  });

  it("roundtrips a valid receipt frame", () => {
    const frame = {
      v: 1 as const,
      type: "receipt" as const,
      id: generateUlid(1700000000000),
      ts: "2026-01-01T00:00:00.000Z",
      originalFrameId: generateUlid(1700000000100),
      toAgentDid: createAgentDid(1700000000200),
      status: "dead_lettered" as const,
      reason: "OpenClaw hook rejected after max attempts",
    };

    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);

    expect(parsed).toEqual(frame);
  });

  it("rejects unknown frame type", () => {
    expect(() =>
      parseFrame({
        v: 1,
        type: "ping",
        id: generateUlid(1700000000000),
        ts: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(ConnectorFrameParseError);
  });

  it("rejects blank reason values", () => {
    expect(() =>
      parseFrame({
        v: 1,
        type: "deliver_ack",
        id: generateUlid(1700000000000),
        ts: "2026-01-01T00:00:00.000Z",
        ackId: generateUlid(1700000000100),
        accepted: false,
        reason: "   ",
      }),
    ).toThrow(ConnectorFrameParseError);
  });

  it("rejects invalid receipt status values", () => {
    expect(() =>
      parseFrame({
        v: 1,
        type: "receipt",
        id: generateUlid(1700000000000),
        ts: "2026-01-01T00:00:00.000Z",
        originalFrameId: generateUlid(1700000000100),
        toAgentDid: createAgentDid(1700000000200),
        status: "delivered",
      }),
    ).toThrow(ConnectorFrameParseError);
  });
});
