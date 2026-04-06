# Design System — Clawdentity Landing Page

## Product Context
- **What this is:** Messaging layer for AI agents. Pair, message, group chat across platforms.
- **Who it's for:** People with personal AI agents (not just developers). Broad, consumer audience.
- **Space:** AI agent interoperability, cross-platform agent communication.
- **Project type:** Marketing landing page (Astro + Starlight docs).

## Aesthetic Direction
- **Direction:** Playful Minimal + Illustrated Characters
- **System name:** Friendly Wire (replaces Iron Ledger)
- **Mood:** Warm, friendly, approachable. Like a messaging app homepage, not a developer tool.
- **Key visual:** Illustrated agent characters (rounded geometric shapes with dot-eyes and smile mouths) on platform islands, connected by dotted lines.

## Typography
- **Display/Headlines:** Satoshi (via Fontshare) — geometric, modern, friendly
- **Body:** Plus Jakarta Sans (Google Fonts) — warm, readable, rounded terminals
- **Mono:** JetBrains Mono — only in docs, never on landing page
- **Scale:** H1 `clamp(3rem, 7vw, 5.5rem)`, H2 `clamp(2rem, 4.5vw, 3rem)`, H3 `clamp(1.25rem, 2.5vw, 1.5rem)`, Body `1.0625rem`

## Color
- **Approach:** Warm, light-first
- **Primary accent:** `#FF6B4A` (coral) — CTAs, highlights, sent bubbles
- **Secondary accent:** `#4ECDC4` (teal) — connected states, secondary highlights
- **Background (light):** `#FEFCF9` (warm cream)
- **Background (dark):** `#13121A` (deep warm navy)
- **Character palette:** Coral `#FF6B4A`, Teal `#4ECDC4`, Purple `#9B8FE8`, Yellow `#F5C542`, Blue `#6BA3E8`

## Spacing
- **Base unit:** 4px (via rem scale)
- **Density:** Comfortable
- **Scale:** xs(0.5rem) sm(1rem) md(1.5rem) lg(2rem) xl(3rem) 2xl(4rem) 3xl(6rem) 4xl(8rem)

## Layout
- **Approach:** Grid-disciplined
- **Max content width:** 76rem
- **Border radius:** sm(8px) md(12px) lg(16px) xl(20px) 2xl(24px)

## Motion
- **Approach:** Intentional, bouncy
- **Character entrance:** `cubic-bezier(0.34, 1.56, 0.64, 1)`, 0.4s
- **Scroll reveal:** fade + translateY(20px), 0.5s, 80ms stagger
- **Connection lines:** stroke-dashoffset draw, 0.8s
- **Reduced motion:** all animations disabled

## Content Rules
- NO developer language on landing page (deploy, backend, CLI, brew, terminal)
- Agents are personal assistants/researchers, not coding bots
- Human/casual tone: "Nope", "Months of work", "Your problem"
- Technical details belong in Starlight docs only

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-01 | Replaced Iron Ledger with Friendly Wire | Landing page was too technical, needed consumer feel |
| 2026-04-01 | Illustrated characters as visual identity | Variant C2 approved — communicates "friendship" better than chat windows |
| 2026-04-01 | Light-first default | Messaging apps default to light mode |
| 2026-04-01 | Satoshi font (replaces Cabinet Grotesk) | Cabinet Grotesk not on Google Fonts; Satoshi is free via Fontshare, same geometric friendly vibe |
