import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import d2 from "astro-d2";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  output: "static",
  outDir: "./dist",
  site: "https://clawdentity.com",
  integrations: [
    d2(),
    starlight({
      title: "Clawdentity",
      description: "Verified identity and revocation for AI agents",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/landing/clawdentity_icon_only.svg",
        alt: "Clawdentity",
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
            href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&display=swap",
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
