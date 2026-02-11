# AGENTS.md (packages/protocol)

## Purpose
- Keep protocol-layer utilities deterministic, runtime-portable, and shared across SDK/registry/CLI.

## Rules
- Prefer battle-tested dependencies for low-level primitives (encoding, IDs) and wrap them with thin project-specific contracts.
- Keep protocol APIs small and explicit; avoid leaking third-party library types into public exports.
- Parse functions should throw `ProtocolParseError` with stable codes for caller-safe branching.
- Maintain Cloudflare Worker portability: avoid Node-only globals in protocol helpers.

## Testing
- Add focused Vitest tests per helper module and one root export test in `src/index.test.ts`.
- Roundtrip tests must cover empty inputs, known vectors, and invalid inputs for parse failures.
- Error tests must assert `ProtocolParseError` code values, not just message strings.
