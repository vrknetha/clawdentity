import { parseDid, parseUlid } from "@clawdentity/protocol";
import { z } from "zod";
import { CONNECTOR_FRAME_VERSION } from "./constants.js";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const FRAME_TYPES = [
  "heartbeat",
  "heartbeat_ack",
  "deliver",
  "deliver_ack",
  "enqueue",
  "enqueue_ack",
] as const;

export const connectorFrameTypeSchema = z.enum(FRAME_TYPES);

const ulidStringSchema = z.string().superRefine((value, ctx) => {
  try {
    parseUlid(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid ULID",
    });
  }
});

const agentDidSchema = z.string().superRefine((value, ctx) => {
  try {
    const parsedDid = parseDid(value);
    if (parsedDid.kind !== "agent") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be an agent DID",
      });
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid DID",
    });
  }
});

const isoTimestampSchema = z.string().superRefine((value, ctx) => {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid ISO-8601 timestamp",
    });
  }
});

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const frameBaseSchema = z
  .object({
    v: z.literal(CONNECTOR_FRAME_VERSION),
    id: ulidStringSchema,
    ts: isoTimestampSchema,
  })
  .strict();

export const heartbeatFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("heartbeat"),
  })
  .strict();

export const heartbeatAckFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("heartbeat_ack"),
    ackId: ulidStringSchema,
  })
  .strict();

export const deliverFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("deliver"),
    fromAgentDid: agentDidSchema,
    toAgentDid: agentDidSchema,
    payload: z.unknown(),
    contentType: nonEmptyStringSchema.optional(),
    conversationId: nonEmptyStringSchema.optional(),
    replyTo: z.string().url().optional(),
  })
  .strict();

export const deliverAckFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("deliver_ack"),
    ackId: ulidStringSchema,
    accepted: z.boolean(),
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const enqueueFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("enqueue"),
    toAgentDid: agentDidSchema,
    payload: z.unknown(),
    conversationId: nonEmptyStringSchema.optional(),
    replyTo: z.string().url().optional(),
  })
  .strict();

export const enqueueAckFrameSchema = frameBaseSchema
  .extend({
    type: z.literal("enqueue_ack"),
    ackId: ulidStringSchema,
    accepted: z.boolean(),
    reason: nonEmptyStringSchema.optional(),
  })
  .strict();

export const connectorFrameSchema = z.discriminatedUnion("type", [
  heartbeatFrameSchema,
  heartbeatAckFrameSchema,
  deliverFrameSchema,
  deliverAckFrameSchema,
  enqueueFrameSchema,
  enqueueAckFrameSchema,
]);

export type HeartbeatFrame = z.infer<typeof heartbeatFrameSchema>;
export type HeartbeatAckFrame = z.infer<typeof heartbeatAckFrameSchema>;
export type DeliverFrame = z.infer<typeof deliverFrameSchema>;
export type DeliverAckFrame = z.infer<typeof deliverAckFrameSchema>;
export type EnqueueFrame = z.infer<typeof enqueueFrameSchema>;
export type EnqueueAckFrame = z.infer<typeof enqueueAckFrameSchema>;

export type ConnectorFrame = z.infer<typeof connectorFrameSchema>;

export type ConnectorFrameParseErrorCode = "INVALID_JSON" | "INVALID_FRAME";

export class ConnectorFrameParseError extends Error {
  readonly code: ConnectorFrameParseErrorCode;
  readonly issues?: z.ZodIssue[];

  constructor(options: {
    code: ConnectorFrameParseErrorCode;
    message: string;
    issues?: z.ZodIssue[];
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ConnectorFrameParseError";
    this.code = options.code;
    this.issues = options.issues;

    if ("cause" in Error.prototype || options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function decodeFrameInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new ConnectorFrameParseError({
        code: "INVALID_JSON",
        message: "Connector frame must be valid JSON",
        cause: error,
      });
    }
  }

  if (input instanceof ArrayBuffer) {
    return decodeFrameInput(new TextDecoder().decode(new Uint8Array(input)));
  }

  if (ArrayBuffer.isView(input)) {
    return decodeFrameInput(
      new TextDecoder().decode(
        new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
      ),
    );
  }

  return input;
}

export function parseFrame(input: unknown): ConnectorFrame {
  const decoded = decodeFrameInput(input);
  const parsed = connectorFrameSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new ConnectorFrameParseError({
      code: "INVALID_FRAME",
      message: "Connector frame does not match schema",
      issues: parsed.error.issues,
      cause: parsed.error,
    });
  }

  return parsed.data;
}

export function serializeFrame(frame: ConnectorFrame): string {
  const parsed = connectorFrameSchema.safeParse(frame);

  if (!parsed.success) {
    throw new ConnectorFrameParseError({
      code: "INVALID_FRAME",
      message: "Connector frame does not match schema",
      issues: parsed.error.issues,
      cause: parsed.error,
    });
  }

  return JSON.stringify(parsed.data);
}
