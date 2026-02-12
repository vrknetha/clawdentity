import { z } from "zod";
import { decodeBase64url } from "./base64url.js";
import { parseDid } from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { hasControlChars } from "./text.js";
import { parseUlid } from "./ulid.js";

export const MAX_AGENT_NAME_LENGTH = 64;
export const MAX_AGENT_DESCRIPTION_LENGTH = 280;
export const AGENT_NAME_REGEX = /^[A-Za-z0-9._ -]{1,64}$/;

const MAX_FRAMEWORK_LENGTH = 32;

export type AitCnfJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
};

function invalidAitClaims(message: string): ProtocolParseError {
  return new ProtocolParseError("INVALID_AIT_CLAIMS", message);
}

export function validateAgentName(name: string): boolean {
  return AGENT_NAME_REGEX.test(name);
}

export const aitClaimsSchema = z
  .object({
    iss: z.string().min(1, "iss is required"),
    sub: z.string().min(1, "sub is required"),
    ownerDid: z.string().min(1, "ownerDid is required"),
    name: z
      .string()
      .refine(validateAgentName, "name contains invalid characters or length"),
    framework: z
      .string()
      .min(1, "framework is required")
      .max(MAX_FRAMEWORK_LENGTH)
      .refine(
        (value) => !hasControlChars(value),
        "framework contains control characters",
      ),
    description: z
      .string()
      .max(MAX_AGENT_DESCRIPTION_LENGTH)
      .refine(
        (value) => !hasControlChars(value),
        "description contains control characters",
      )
      .optional(),
    cnf: z
      .object({
        jwk: z
          .object({
            kty: z.literal("OKP"),
            crv: z.literal("Ed25519"),
            x: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    iat: z.number().int().nonnegative(),
    nbf: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    jti: z.string().min(1),
  })
  .strict()
  .superRefine((claims, ctx) => {
    try {
      const parsedSub = parseDid(claims.sub);
      if (parsedSub.kind !== "agent") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "sub must be an agent DID",
          path: ["sub"],
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sub must be a valid DID",
        path: ["sub"],
      });
    }

    try {
      const parsedOwnerDid = parseDid(claims.ownerDid);
      if (parsedOwnerDid.kind !== "human") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ownerDid must be a human DID",
          path: ["ownerDid"],
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerDid must be a valid DID",
        path: ["ownerDid"],
      });
    }

    try {
      decodeBase64url(claims.cnf.jwk.x);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cnf.jwk.x must be valid base64url",
        path: ["cnf", "jwk", "x"],
      });
    }

    try {
      parseUlid(claims.jti);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "jti must be a valid ULID",
        path: ["jti"],
      });
    }

    if (claims.exp <= claims.nbf) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exp must be greater than nbf",
        path: ["exp"],
      });
    }

    if (claims.exp <= claims.iat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exp must be greater than iat",
        path: ["exp"],
      });
    }
  });

export type AitClaims = z.infer<typeof aitClaimsSchema>;

export function parseAitClaims(input: unknown): AitClaims {
  const parsed = aitClaimsSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw invalidAitClaims(
      message.length > 0 ? message : "Invalid AIT claims payload",
    );
  }
  return parsed.data;
}
