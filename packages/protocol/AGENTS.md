# AGENTS.md (packages/protocol)

## Purpose
- Keep protocol-layer utilities deterministic, runtime-portable, and shared across SDK/registry/CLI.

## Rules
- Prefer battle-tested dependencies for low-level primitives (encoding, IDs) and wrap them with thin project-specific contracts.
- Keep protocol APIs small and explicit; avoid leaking third-party library types into public exports.
- Parse functions should throw `ProtocolParseError` with stable codes for caller-safe branching.
- Maintain Cloudflare Worker portability: avoid Node-only globals in protocol helpers.
- DID v2 is mandatory: only accept/build `did:cdi:<authority>:<agent|human>:<ulid>`; do not add compatibility paths for legacy DID methods.
- DID authorities must be DNS hostnames (lowercase dot-separated labels, hyphen allowed inside labels, no empty labels, no leading/trailing hyphen per label).
- Use `parseAgentDid` / `parseHumanDid` for entity-specific checks instead of ad-hoc string checks or generic `parseDid` branching.
- All DID construction must pass explicit authority (`makeAgentDid(authority, ulid)`, `makeHumanDid(authority, ulid)`); never infer or hardcode from unrelated context.
- Keep AIT schema parsing strict (`.strict()` objects) so unknown claims are rejected by default.
- Validate risky identity fields (`name`, `description`) with explicit allowlists/length caps; never pass through raw control characters.
- Enforce `cnf.jwk.x` semantics for AIT parsing: value must be base64url and decode to exactly 32 bytes for Ed25519 (`kty=OKP`, `crv=Ed25519`).
- Reuse existing protocol validators/parsers (`parseDid`, `parseAgentDid`, `parseHumanDid`, `parseUlid`, base64url helpers) instead of duplicating claim validation logic.
- AIT/CRL claims must validate that `iss` is a URL with hostname and that hostname equals DID authority for subject/owner/revocation entries.
- Keep HTTP signing canonical strings deterministic: canonicalize method, normalized path (path + query), timestamp, nonce, and body hash exactly as `README.md`, `ARCHITECTURE.md`, and the policy docs describe (see `CLAW-PROOF-V1\n<METHOD>\n<PATH>\n<TS>\n<NONCE>\n<BODY-SHA256>`).
- Mirror the AIT guardrails for CRL payloads: `crl.ts` keeps `.strict()` definitions, requires at least one revocation entry, enforces `agentDid` is a `did:cdi:<authority>:agent:<ulid>` matching `iss` hostname, validates `revocation.jti` as ULID, `exp > iat`, and surfaces `INVALID_CRL_CLAIMS` via `ProtocolParseError`.
- Reuse cross-module helpers (e.g., `text.ts`’s `hasControlChars`) so control-character checks stay consistent across AIT and CRL validation.
- Share header names/values via protocol exports so SDK/Proxy layers import a single source of truth (e.g., `X-Claw-Timestamp`, `X-Claw-Nonce`, `X-Claw-Body-SHA256`, and `X-Claw-Proof`).
- Keep T02 canonicalization minimal and deterministic; replay/skew/nonce policy enforcement is handled in later tickets (`T07`, `T08`, `T09`).
- Define shared API route fragments in protocol exports (for example `ADMIN_BOOTSTRAP_PATH`) so CLI/SDK/apps avoid hardcoded duplicate endpoint literals.
- Keep lifecycle route constants together in `endpoints.ts` (e.g., `ADMIN_BOOTSTRAP_PATH`, `AGENT_REGISTRATION_CHALLENGE_PATH`, `AGENT_AUTH_REFRESH_PATH`, `AGENT_AUTH_VALIDATE_PATH`, `ME_API_KEYS_PATH`) so registry, proxy, and CLI stay contract-synchronized.
- Keep protocol route constants scoped to active contracts only; remove deprecated endpoint exports immediately when a flow is retired.
- Keep internal identity route constants in protocol exports (`INTERNAL_IDENTITY_AGENT_OWNERSHIP_PATH`) so service-to-service ownership checks stay synchronized.
- Keep relay contract constants in protocol exports (`RELAY_CONNECT_PATH`, `RELAY_RECIPIENT_AGENT_DID_HEADER`) so connector and hook routing stay synchronized across apps.
- Keep registration-proof canonicalization in protocol exports (`canonicalizeAgentRegistrationProof`) so CLI signing and registry verification use an identical message format.
- Keep optional proof fields deterministic in canonical strings (empty-string placeholders) to avoid default-value mismatches between clients and server.

## Testing
- Add focused Vitest tests per helper module and one root export test in `src/index.test.ts`.
- Roundtrip tests must cover empty inputs, known vectors, and invalid inputs for parse failures.
- Error tests must assert `ProtocolParseError` code values, not just message strings.
- CRL helpers specifically need coverage for valid payloads, missing or empty revocation entries, invalid `agentDid`/`jti` values, and `exp <= iat`, all verifying the `INVALID_CRL_CLAIMS` code.
