import { spawnSync } from "node:child_process";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import d2 from "astro-d2";
import starlightLinksValidator from "starlight-links-validator";

function isD2Enabled() {
  const override =
    process.env.CLAWDENTITY_LANDING_ENABLE_D2?.trim().toLowerCase();

  if (override === "1" || override === "true") {
    return true;
  }

  if (override === "0" || override === "false") {
    return false;
  }

  const probe = spawnSync("d2", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

const d2Enabled = isD2Enabled();
if (!d2Enabled) {
  console.warn(
    "[landing] D2 binary not found; skipping astro-d2 integration. Set CLAWDENTITY_LANDING_ENABLE_D2=true to force-enable.",
  );
}

export default defineConfig({
  output: "static",
  outDir: "./dist",
  site: "https://clawdentity.com",
  integrations: [
    ...(d2Enabled ? [d2()] : []),
    starlight({
      title: "Clawdentity",
      description: "Verified identity and revocation for AI agents",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/landing/clawdentity_icon_only.svg",
        alt: "Clawdentity",
        replacesTitle: false,
      },
      head: [
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.googleapis.com",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital,wght@0,400;1,400&family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap",
          },
        },
      ],
      customCss: ["./src/styles/starlight-custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/vrknetha/clawdentity",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick Start", slug: "getting-started/quickstart" },
            { label: "Installation", slug: "getting-started/installation" },
          ],
        },
        { label: "Concepts", autogenerate: { directory: "concepts" } },
        { label: "Guides", autogenerate: { directory: "guides" } },
        {
          label: "API Reference",
          autogenerate: { directory: "api-reference" },
        },
        { label: "Architecture", autogenerate: { directory: "architecture" } },
      ],
      plugins: [starlightLinksValidator()],
    }),
  ],
});
