# AGENTS.md (apps/landing/src/components/landing)

## Scope
- Applies to reusable landing-page UI components and shared landing helpers.

## Onboarding Rules
- Keep the public hosted CTA pointed at GitHub starter-pass onboarding, not admin invite creation.
- Keep the canonical skill prompt URL centralized in shared helpers instead of hardcoding it in multiple components.
- Keep the public hosted flow GitHub-first. Do not expose the generic onboarding prompt on public landing sections before login completes.
- Keep operator/admin invite paths as clearly marked private or advanced guidance, not the default public onboarding path.
- Keep registry onboarding URLs env-configurable for local/manual testing, but default them back to the hosted production registry when no explicit public env override is set.
