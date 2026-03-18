import {
  decodeBase64url,
  encodeBase64url,
  GITHUB_ONBOARDING_CALLBACK_PATH,
} from "@clawdentity/protocol";
import {
  AppError,
  addSeconds,
  nowUtcMs,
  type RegistryConfig,
} from "@clawdentity/sdk";
import { constantTimeEqual } from "../auth/api-key-token.js";
import { LANDING_URL_BY_ENVIRONMENT } from "../server/constants.js";
import { starterPassDisabledError } from "../starter-pass-lifecycle.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_STATE_COOKIE = "clw_github_oauth_state";
const GITHUB_STATE_TTL_SECONDS = 10 * 60;

type SignedStatePayload = {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

export type GithubProfile = {
  subject: string;
  login: string;
  displayName: string;
};

type GithubAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type GithubUserResponse = {
  id?: number;
  login?: string;
  name?: string | null;
};

function githubOnboardingInvalidStateError(): AppError {
  return new AppError({
    code: "GITHUB_ONBOARDING_INVALID_STATE",
    message: "GitHub onboarding state is invalid",
    status: 400,
    expose: true,
  });
}

function getGithubStateSecret(config: RegistryConfig): string {
  const secret = config.GITHUB_OAUTH_STATE_SECRET?.trim();
  if (!secret) {
    throw starterPassDisabledError();
  }

  return secret;
}

function getGithubClientId(config: RegistryConfig): string {
  const clientId = config.GITHUB_CLIENT_ID?.trim();
  if (!clientId) {
    throw starterPassDisabledError();
  }

  return clientId;
}

function getGithubClientSecret(config: RegistryConfig): string {
  const clientSecret = config.GITHUB_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw starterPassDisabledError();
  }

  return clientSecret;
}

async function signValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );

  return encodeBase64url(new Uint8Array(signature));
}

export function getGithubStateCookieName(): string {
  return GITHUB_STATE_COOKIE;
}

export function resolveLandingUrl(config: RegistryConfig): string {
  return config.LANDING_URL ?? LANDING_URL_BY_ENVIRONMENT[config.ENVIRONMENT];
}

export function resolveGithubCallbackUrl(config: RegistryConfig): string {
  const issuer = config.REGISTRY_ISSUER_URL?.trim();
  if (!issuer) {
    throw new AppError({
      code: "CONFIG_VALIDATION_FAILED",
      message: "Registry configuration is invalid",
      status: 500,
      expose: true,
      details: {
        fieldErrors: {
          REGISTRY_ISSUER_URL: ["REGISTRY_ISSUER_URL is required"],
        },
        formErrors: [],
      },
    });
  }

  const base = issuer.endsWith("/") ? issuer : `${issuer}/`;
  return new URL(
    GITHUB_ONBOARDING_CALLBACK_PATH.replace(/^\//, ""),
    base,
  ).toString();
}

export async function createSignedGithubStateCookie(input: {
  config: RegistryConfig;
  nonce: string;
  nowMs?: number;
}): Promise<string> {
  const nowMs = input.nowMs ?? nowUtcMs();
  const payload: SignedStatePayload = {
    nonce: input.nonce,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: addSeconds(nowMs, GITHUB_STATE_TTL_SECONDS),
  };
  const encodedPayload = encodeBase64url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await signValue(
    encodedPayload,
    getGithubStateSecret(input.config),
  );

  return `${encodedPayload}.${signature}`;
}

export async function verifySignedGithubStateCookie(input: {
  config: RegistryConfig;
  cookieValue?: string;
  state: string;
  nowMs?: number;
}): Promise<SignedStatePayload> {
  if (!input.cookieValue) {
    throw githubOnboardingInvalidStateError();
  }

  const [encodedPayload, signature] = input.cookieValue.split(".", 2);
  if (!encodedPayload || !signature) {
    throw githubOnboardingInvalidStateError();
  }

  const expectedSignature = await signValue(
    encodedPayload,
    getGithubStateSecret(input.config),
  );
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw githubOnboardingInvalidStateError();
  }

  let payload: SignedStatePayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(decodeBase64url(encodedPayload)),
    ) as SignedStatePayload;
  } catch {
    throw githubOnboardingInvalidStateError();
  }

  if (
    typeof payload.nonce !== "string" ||
    typeof payload.expiresAt !== "string" ||
    !constantTimeEqual(payload.nonce, input.state)
  ) {
    throw githubOnboardingInvalidStateError();
  }

  const nowMs = input.nowMs ?? nowUtcMs();
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new AppError({
      code: "GITHUB_ONBOARDING_STATE_EXPIRED",
      message: "GitHub onboarding state has expired",
      status: 400,
      expose: true,
    });
  }

  return payload;
}

export function buildGithubAuthorizeUrl(input: {
  config: RegistryConfig;
  state: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", getGithubClientId(input.config));
  url.searchParams.set("redirect_uri", resolveGithubCallbackUrl(input.config));
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", input.state);

  return url.toString();
}

export async function exchangeGithubCode(input: {
  config: RegistryConfig;
  code: string;
}): Promise<string> {
  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "clawdentity-registry",
    },
    body: JSON.stringify({
      client_id: getGithubClientId(input.config),
      client_secret: getGithubClientSecret(input.config),
      code: input.code,
      redirect_uri: resolveGithubCallbackUrl(input.config),
    }),
  });

  let payload: GithubAccessTokenResponse | undefined;
  try {
    payload = (await response.json()) as GithubAccessTokenResponse;
  } catch {
    payload = undefined;
  }

  if (!response.ok || typeof payload?.access_token !== "string") {
    throw new AppError({
      code: "GITHUB_ONBOARDING_TOKEN_EXCHANGE_FAILED",
      message:
        payload?.error_description ??
        payload?.error ??
        "GitHub token exchange failed",
      status: 502,
      expose: true,
    });
  }

  return payload.access_token;
}

export async function fetchGithubProfile(input: {
  accessToken: string;
}): Promise<GithubProfile> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      "user-agent": "clawdentity-registry",
    },
  });

  let payload: GithubUserResponse | undefined;
  try {
    payload = (await response.json()) as GithubUserResponse;
  } catch {
    payload = undefined;
  }

  if (
    !response.ok ||
    typeof payload?.id !== "number" ||
    typeof payload.login !== "string"
  ) {
    throw new AppError({
      code: "GITHUB_ONBOARDING_PROFILE_FAILED",
      message: "GitHub profile lookup failed",
      status: 502,
      expose: true,
    });
  }

  return {
    subject: String(payload.id),
    login: payload.login.trim(),
    displayName:
      typeof payload.name === "string" && payload.name.trim().length > 0
        ? payload.name.trim()
        : payload.login.trim(),
  };
}

export function buildOnboardingRedirectUrl(input: {
  config: RegistryConfig;
  fragment: Record<string, string>;
}): string {
  const url = new URL(
    "/getting-started/github/",
    resolveLandingUrl(input.config),
  );
  url.hash = new URLSearchParams(input.fragment).toString();
  return url.toString();
}
