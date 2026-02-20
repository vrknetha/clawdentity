import { z } from "zod";
import { decodeBase64url } from "./base64url.js";
import { ProtocolParseError } from "./errors.js";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const X25519_PUBLIC_KEY_BYTES = 32;
const XCHACHA20_NONCE_BYTES = 24;
const INVALID_E2EE_PAYLOAD = "INVALID_E2EE_PAYLOAD" as const;

const base64urlStringSchema = z.string().min(1);
const isoTimestampSchema = z.string().superRefine((value, ctx) => {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sentAt must be a valid ISO-8601 timestamp",
    });
  }
});

function validateBase64urlLength(
  input: string,
  expectedBytes: number,
  label: string,
  ctx: z.RefinementCtx,
): void {
  try {
    const decoded = decodeBase64url(input);
    if (decoded.length !== expectedBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must decode to ${expectedBytes} bytes`,
      });
    }
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must be valid base64url`,
    });
  }
}

export const encryptedRelayPayloadV1Schema = z
  .object({
    kind: z.literal("claw_e2ee_v1"),
    alg: z.literal("X25519_XCHACHA20POLY1305_HKDF_SHA256"),
    sessionId: z.string().min(1, "sessionId is required"),
    epoch: z.number().int().nonnegative(),
    counter: z.number().int().nonnegative(),
    nonce: base64urlStringSchema,
    ciphertext: base64urlStringSchema,
    senderE2eePub: base64urlStringSchema,
    rekeyPublicKey: base64urlStringSchema.optional(),
    sentAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((payload, ctx) => {
    validateBase64urlLength(payload.nonce, XCHACHA20_NONCE_BYTES, "nonce", ctx);
    validateBase64urlLength(
      payload.senderE2eePub,
      X25519_PUBLIC_KEY_BYTES,
      "senderE2eePub",
      ctx,
    );

    if (payload.rekeyPublicKey !== undefined) {
      validateBase64urlLength(
        payload.rekeyPublicKey,
        X25519_PUBLIC_KEY_BYTES,
        "rekeyPublicKey",
        ctx,
      );
    }

    try {
      decodeBase64url(payload.ciphertext);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ciphertext must be valid base64url",
      });
    }
  });

export type EncryptedRelayPayloadV1 = z.infer<
  typeof encryptedRelayPayloadV1Schema
>;

export function parseEncryptedRelayPayloadV1(
  input: unknown,
): EncryptedRelayPayloadV1 {
  const parsed = encryptedRelayPayloadV1Schema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new ProtocolParseError(
      INVALID_E2EE_PAYLOAD,
      message.length > 0 ? message : "Invalid E2EE payload",
    );
  }

  return parsed.data;
}
