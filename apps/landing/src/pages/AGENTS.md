# AGENTS.md (apps/landing/src/pages)

## Scope
- Applies to landing page route components in `apps/landing/src/pages`.

## Rules
- Keep hosted onboarding GitHub-first: do not render usable starter-pass prompts or redeem commands before callback fragment data is present.
- When callback fragments include user profile fields (for example `displayName`), hydrate form defaults from the fragment before users copy generated commands.
- Keep local testing behavior explicit: pages may read local/public registry URL overrides, but defaults should remain production-safe.
