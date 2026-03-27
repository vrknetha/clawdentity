# AGENTS.md (apps/landing/src/content)

## Scope
- Applies to published docs and other content authored under `apps/landing/src/content`.

## Docs Rules
- Hosted/public onboarding must stay GitHub-first. Do not expose the generic onboarding prompt on public landing pages or in the default hosted docs before login completes.
- `/getting-started/github/` is the hosted prompt surface. Keep prompt generation there, driven by the GitHub redirect payload.
- `/skill.md` remains the canonical skill artifact for private, self-hosted, operator, or advanced/manual paths. Label those paths clearly so they are not confused with hosted onboarding.
- CLI docs must match the actual Rust binary help output. Re-check flags and subcommands before changing docs, especially `install --for`, `provider *`, and `pair *`.
- Connector docs must keep `/hooks/wake` as the default inbound path unless runtime defaults change in Rust; if `/hooks/agent` is documented, call out that it is explicit/opt-in.
- OpenClaw setup docs must describe `--openclaw-agent-id` routing behavior accurately: mapping persists in connector assignment state, applies to `/hooks/agent`, and does not change `/hooks/wake` defaults.
- When starter-pass behavior changes, update both user-facing docs and the landing copy in the same change.
- Keep proxy docs aligned with runtime identity transport: header-first by default, body injection only as an explicit legacy opt-in.
- SDK docs that mention HTTP proof verification must state that timestamp freshness is enforced by default and should recommend the replay-protected one-call verifier for nonce enforcement.
