# AGENTS.md (packages/protocol)

## Purpose
- Keep protocol-layer utilities deterministic, runtime-portable, and shared across SDK/registry/CLI.

## Rules
- Prefer battle-tested dependencies for low-level primitives (encoding, IDs) and wrap them with thin project-specific contracts.
- Keep protocol APIs small and explicit; avoid leaking third-party library types into public exports.
- Parse functions should throw `ProtocolParseError` with stable codes for caller-safe branching.
- Maintain Cloudflare Worker portability: avoid Node-only globals in protocol helpers.
- Keep AIT schema parsing strict (`.strict()` objects) so unknown claims are rejected by default.
- Validate risky identity fields (`name`, `description`) with explicit allowlists/length caps; never pass through raw control characters.
- Reuse existing protocol validators/parsers (`parseDid`, `parseUlid`, base64url helpers) instead of duplicating claim validation logic.
- Keep HTTP signing canonical strings deterministic: canonicalize method, normalized path (path + query), timestamp, nonce, and body hash exactly as `README.md`, `PRD.md`, and the policy docs describe (see `CLAW-PROOF-V1\n<METHOD>\n<PATH>\n<TS>\n<NONCE>\n<BODY-SHA256>`).
- Share header names/values via protocol exports so SDK/Proxy layers import a single source of truth (e.g., `X-Claw-Timestamp`, `X-Claw-Nonce`, `X-Claw-Body-SHA256`, and `X-Claw-Proof`).
- Keep T02 canonicalization minimal and deterministic; replay/skew/nonce policy enforcement is handled in later tickets (`T07`, `T08`, `T09`).

## Testing
- Add focused Vitest tests per helper module and one root export test in `src/index.test.ts`.
- Roundtrip tests must cover empty inputs, known vectors, and invalid inputs for parse failures.
- Error tests must assert `ProtocolParseError` code values, not just message strings.
