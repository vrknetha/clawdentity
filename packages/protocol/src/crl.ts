import { z } from "zod";
import { parseDid } from "./did.js";
import { ProtocolParseError } from "./errors.js";
import { hasControlChars } from "./text.js";
import { parseUlid } from "./ulid.js";

const INVALID_CRL_CLAIMS = "INVALID_CRL_CLAIMS" as const;

export const crlClaimsSchema = z
  .object({
    iss: z.string().min(1, "iss is required"),
    jti: z.string().min(1, "jti is required"),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    revocations: z
      .array(
        z
          .object({
            jti: z.string().min(1, "revocation.jti is required"),
            agentDid: z.string().min(1, "agentDid is required"),
            reason: z.string().max(280).optional(),
            revokedAt: z.number().int().nonnegative(),
          })
          .strict()
          .superRefine((revocation, ctx) => {
            if (hasControlChars(revocation.agentDid)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "revocation.agentDid contains control characters",
                path: ["agentDid"],
              });
            }
          }),
      )
      .min(1, "revocations must include at least one entry"),
  })
  .strict()
  .superRefine((claims, ctx) => {
    if (claims.exp <= claims.iat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exp must be greater than iat",
        path: ["exp"],
      });
    }

    for (const [index, revocation] of claims.revocations.entries()) {
      try {
        const parsedAgentDid = parseDid(revocation.agentDid);
        if (parsedAgentDid.kind !== "agent") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "revocation.agentDid must refer to an agent DID",
            path: ["revocations", index, "agentDid"],
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "revocation.agentDid must be a valid DID",
          path: ["revocations", index, "agentDid"],
        });
      }

      try {
        parseUlid(revocation.jti);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "revocation.jti must be a valid ULID",
          path: ["revocations", index, "jti"],
        });
      }
    }
  });

export type CrlClaims = z.infer<typeof crlClaimsSchema>;

export function parseCrlClaims(input: unknown): CrlClaims {
  const parsed = crlClaimsSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new ProtocolParseError(
      INVALID_CRL_CLAIMS,
      message.length > 0 ? message : "Invalid CRL claims payload",
    );
  }
  return parsed.data;
}
