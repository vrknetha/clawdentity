import {
  GITHUB_ONBOARDING_CALLBACK_PATH,
  GITHUB_ONBOARDING_START_PATH,
  STARTER_PASSES_REDEEM_PATH,
} from "@clawdentity/protocol";
import { parseRegistryConfig } from "@clawdentity/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSignedGithubStateCookie,
  getGithubStateCookieName,
} from "../onboarding/github.js";
import { createRegistryApp } from "../server.js";
import { createTestBindings } from "./helpers/agent-registration.js";
import { createFakeDb } from "./helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createGithubBindings(database: D1Database) {
  return createTestBindings(database, {
    REGISTRY_ISSUER_URL: "https://registry.clawdentity.com",
    PROXY_URL: "https://proxy.clawdentity.com",
    LANDING_URL: "https://clawdentity.com",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_OAUTH_STATE_SECRET: "state-secret",
  });
}

function mockGithubFetch() {
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(
        JSON.stringify({
          access_token: "github-access-token",
          token_type: "bearer",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    if (url.includes("api.github.com/user")) {
      return new Response(
        JSON.stringify({
          id: 42,
          login: "octocat",
          name: "The Octocat",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}

describe(`GET ${GITHUB_ONBOARDING_START_PATH}`, () => {
  it("sets a signed state cookie and redirects to GitHub", async () => {
    const { database } = createFakeDb([]);
    const bindings = createGithubBindings(database);

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_START_PATH}`,
      {},
      bindings,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=github-client-id");
    expect(location).toContain(
      encodeURIComponent(
        "https://registry.clawdentity.com/v1/onboarding/github/callback",
      ),
    );

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(getGithubStateCookieName());
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("does not force Secure on plain-http local deployments", async () => {
    const { database } = createFakeDb([]);
    const bindings = createGithubBindings(database);

    const response = await createRegistryApp().request(
      `http://127.0.0.1:8788${GITHUB_ONBOARDING_START_PATH}`,
      {},
      bindings,
    );

    expect(response.status).toBe(302);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain(getGithubStateCookieName());
    expect(setCookie).not.toContain("Secure");
  });
});

describe(`GET ${GITHUB_ONBOARDING_CALLBACK_PATH}`, () => {
  it("rejects invalid state cookie and redirects with an error fragment", async () => {
    const { database } = createFakeDb([]);
    const bindings = createGithubBindings(database);

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_CALLBACK_PATH}?state=bad-state&code=github-code`,
      {
        headers: {
          cookie: `${getGithubStateCookieName()}=bad-cookie`,
        },
      },
      bindings,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://clawdentity.com");
    expect(location.hash).toContain("error=github_onboarding_failed");
  });

  it("creates a starter pass on first successful GitHub login", async () => {
    const { database, starterPassInserts } = createFakeDb([]);
    const bindings = createGithubBindings(database);
    const config = parseRegistryConfig(bindings);
    const cookieValue = await createSignedGithubStateCookie({
      config,
      nonce: "01HF7YAT31JZHSMW1CG6Q6MHB7",
    });
    mockGithubFetch();

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_CALLBACK_PATH}?state=01HF7YAT31JZHSMW1CG6Q6MHB7&code=github-code`,
      {
        headers: {
          cookie: `${getGithubStateCookieName()}=${cookieValue}`,
        },
      },
      bindings,
    );

    expect(response.status).toBe(302);
    expect(starterPassInserts).toHaveLength(1);
    const location = new URL(response.headers.get("location") ?? "");
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    expect(fragment.get("code")).toMatch(/^clw_stp_/);
    expect(fragment.get("displayName")).toBe("The Octocat");
    expect(fragment.get("providerLogin")).toBe("octocat");
  });

  it("reuses an existing active starter pass before redemption", async () => {
    const { database, starterPassInserts } = createFakeDb([], [], {
      starterPassRows: [
        {
          id: "01HF7YAT31JZHSMW1CG6Q6MHB8",
          code: "clw_stp_existing",
          provider: "github",
          providerSubject: "42",
          providerLogin: "octocat",
          displayName: "The Octocat",
          redeemedBy: null,
          issuedAt: "2026-01-01T00:00:00.000Z",
          redeemedAt: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
          status: "active",
        },
      ],
    });
    const bindings = createGithubBindings(database);
    const config = parseRegistryConfig(bindings);
    const cookieValue = await createSignedGithubStateCookie({
      config,
      nonce: "01HF7YAT31JZHSMW1CG6Q6MHB9",
    });
    mockGithubFetch();

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_CALLBACK_PATH}?state=01HF7YAT31JZHSMW1CG6Q6MHB9&code=github-code`,
      {
        headers: {
          cookie: `${getGithubStateCookieName()}=${cookieValue}`,
        },
      },
      bindings,
    );

    expect(response.status).toBe(302);
    expect(starterPassInserts).toHaveLength(0);
    const location = new URL(response.headers.get("location") ?? "");
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    expect(fragment.get("code")).toBe("clw_stp_existing");
  });

  it("does not mint a second starter pass after redemption", async () => {
    const { database, starterPassInserts } = createFakeDb([], [], {
      starterPassRows: [
        {
          id: "01HF7YAT31JZHSMW1CG6Q6MHC0",
          code: "clw_stp_redeemed",
          provider: "github",
          providerSubject: "42",
          providerLogin: "octocat",
          displayName: "The Octocat",
          redeemedBy: "human-1",
          issuedAt: "2026-01-01T00:00:00.000Z",
          redeemedAt: "2026-01-01T00:01:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          status: "redeemed",
        },
      ],
    });
    const bindings = createGithubBindings(database);
    const config = parseRegistryConfig(bindings);
    const cookieValue = await createSignedGithubStateCookie({
      config,
      nonce: "01HF7YAT31JZHSMW1CG6Q6MHC1",
    });
    mockGithubFetch();

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_CALLBACK_PATH}?state=01HF7YAT31JZHSMW1CG6Q6MHC1&code=github-code`,
      {
        headers: {
          cookie: `${getGithubStateCookieName()}=${cookieValue}`,
        },
      },
      bindings,
    );

    expect(response.status).toBe(302);
    expect(starterPassInserts).toHaveLength(0);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.hash).toContain("error=starter_pass_already_used");
  });

  it("reissues a fresh starter pass after expiry on repeat GitHub login", async () => {
    const { database, starterPassInserts, starterPassUpdates } = createFakeDb(
      [],
      [],
      {
        starterPassRows: [
          {
            id: "01HF7YAT31JZHSMW1CG6Q6MHC4",
            code: "clw_stp_expired_old",
            provider: "github",
            providerSubject: "42",
            providerLogin: "octocat",
            displayName: "Old Name",
            redeemedBy: null,
            issuedAt: "2026-01-01T00:00:00.000Z",
            redeemedAt: null,
            expiresAt: "2000-01-01T00:00:00.000Z",
            status: "active",
          },
        ],
      },
    );
    const bindings = createGithubBindings(database);
    const config = parseRegistryConfig(bindings);
    const cookieValue = await createSignedGithubStateCookie({
      config,
      nonce: "01HF7YAT31JZHSMW1CG6Q6MHC5",
    });
    mockGithubFetch();

    const response = await createRegistryApp().request(
      `https://registry.clawdentity.com${GITHUB_ONBOARDING_CALLBACK_PATH}?state=01HF7YAT31JZHSMW1CG6Q6MHC5&code=github-code`,
      {
        headers: {
          cookie: `${getGithubStateCookieName()}=${cookieValue}`,
        },
      },
      bindings,
    );

    expect(response.status).toBe(302);
    expect(starterPassInserts).toHaveLength(0);
    expect(starterPassUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "active",
          provider_login: "octocat",
          display_name: "The Octocat",
          redeemed_by: null,
          redeemed_at: null,
          matched_rows: 1,
        }),
      ]),
    );

    const location = new URL(response.headers.get("location") ?? "");
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
    expect(fragment.get("code")).toMatch(/^clw_stp_/);
    expect(fragment.get("code")).not.toBe("clw_stp_expired_old");
    expect(fragment.get("displayName")).toBe("The Octocat");
    expect(fragment.get("providerLogin")).toBe("octocat");
  });
});

describe(`POST ${STARTER_PASSES_REDEEM_PATH}`, () => {
  it("redeems an active starter pass and returns PAT bootstrap data", async () => {
    const { database, humanInserts, apiKeyInserts, starterPassUpdates } =
      createFakeDb([], [], {
        starterPassRows: [
          {
            id: "01HF7YAT31JZHSMW1CG6Q6MHC2",
            code: "clw_stp_active",
            provider: "github",
            providerSubject: "42",
            providerLogin: "octocat",
            displayName: "The Octocat",
            redeemedBy: null,
            issuedAt: "2026-01-01T00:00:00.000Z",
            redeemedAt: null,
            expiresAt: "2099-01-01T00:00:00.000Z",
            status: "active",
          },
        ],
      });
    const bindings = createGithubBindings(database);

    const response = await createRegistryApp().request(
      STARTER_PASSES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_stp_active",
          displayName: "Alice",
        }),
      },
      bindings,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      human: { displayName: string };
      apiKey: { token: string };
      proxyUrl: string;
    };
    expect(body.human.displayName).toBe("Alice");
    expect(body.apiKey.token.startsWith("clw_pat_")).toBe(true);
    expect(body.proxyUrl).toBe("https://proxy.clawdentity.com");
    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(starterPassUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "redeemed",
          matched_rows: 1,
        }),
      ]),
    );
  });

  it("rejects an expired starter pass", async () => {
    const { database } = createFakeDb([], [], {
      starterPassRows: [
        {
          id: "01HF7YAT31JZHSMW1CG6Q6MHC3",
          code: "clw_stp_expired",
          provider: "github",
          providerSubject: "42",
          providerLogin: "octocat",
          displayName: "The Octocat",
          redeemedBy: null,
          issuedAt: "2026-01-01T00:00:00.000Z",
          redeemedAt: null,
          expiresAt: "2000-01-01T00:00:00.000Z",
          status: "active",
        },
      ],
    });
    const bindings = createGithubBindings(database);

    const response = await createRegistryApp().request(
      STARTER_PASSES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_stp_expired",
          displayName: "Alice",
        }),
      },
      bindings,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("STARTER_PASS_EXPIRED");
  });
});
