import {
  generateUlid,
  INVITES_PATH,
  INVITES_REDEEM_PATH,
} from "@clawdentity/protocol";
import { describe, expect, it } from "vitest";
import { createRegistryApp } from "../server.js";
import { createFakeDb, makeValidPatContext } from "./helpers.js";

describe(`POST ${INVITES_PATH}`, () => {
  it("returns 401 when PAT is missing", async () => {
    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("API_KEY_MISSING");
  });

  it("returns 403 when PAT owner is not an admin", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([
      {
        ...authRow,
        humanRole: "user",
      },
    ]);

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_CREATE_FORBIDDEN");
  });

  it("returns 400 when payload is invalid", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow]);

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expiresAt: "not-an-iso-date",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    };
    expect(body.error.code).toBe("INVITE_CREATE_INVALID");
    expect(body.error.details?.fieldErrors?.expiresAt).toEqual([
      "expiresAt must be a valid ISO-8601 datetime",
    ]);
  });

  it("creates invite code and persists invite row", async () => {
    const { token, authRow } = await makeValidPatContext();
    const { database, inviteInserts } = createFakeDb([authRow]);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await createRegistryApp().request(
      INVITES_PATH,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expiresAt,
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      invite: {
        id: string;
        code: string;
        createdBy: string;
        expiresAt: string | null;
        createdAt: string;
      };
    };
    expect(body.invite.code.startsWith("clw_inv_")).toBe(true);
    expect(body.invite.createdBy).toBe("human-1");
    expect(body.invite.expiresAt).toBe(expiresAt);
    expect(body.invite.createdAt).toEqual(expect.any(String));

    expect(inviteInserts).toHaveLength(1);
    expect(inviteInserts[0]?.id).toBe(body.invite.id);
    expect(inviteInserts[0]?.code).toBe(body.invite.code);
    expect(inviteInserts[0]?.created_by).toBe("human-1");
    expect(inviteInserts[0]?.expires_at).toBe(expiresAt);
  });
});

describe(`POST ${INVITES_REDEEM_PATH}`, () => {
  it("returns 400 when payload is invalid", async () => {
    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      {
        DB: {} as D1Database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    };
    expect(body.error.code).toBe("INVITE_REDEEM_INVALID");
    expect(body.error.details?.fieldErrors?.code).toEqual(["code is required"]);
  });

  it("returns 400 when invite code does not exist", async () => {
    const { database } = createFakeDb([]);

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_missing",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_CODE_INVALID");
  });

  it("returns 400 when invite is expired", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], [], {
      inviteRows: [
        {
          id: generateUlid(1700700000000),
          code: "clw_inv_expired",
          createdBy: "human-1",
          redeemedBy: null,
          agentId: null,
          expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_expired",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_EXPIRED");
  });

  it("returns 409 when invite is already redeemed", async () => {
    const { authRow } = await makeValidPatContext();
    const { database } = createFakeDb([authRow], [], {
      inviteRows: [
        {
          id: generateUlid(1700700001000),
          code: "clw_inv_redeemed",
          createdBy: "human-1",
          redeemedBy: "human-2",
          agentId: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const response = await createRegistryApp().request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: "clw_inv_redeemed",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVITE_REDEEM_ALREADY_USED");
  });

  it("redeems invite and returns PAT that authenticates /v1/me", async () => {
    const { authRow } = await makeValidPatContext();
    const inviteCode = "clw_inv_redeem_success";
    const { database, humanInserts, apiKeyInserts, inviteRows, inviteUpdates } =
      createFakeDb([authRow], [], {
        inviteRows: [
          {
            id: generateUlid(1700700002000),
            code: inviteCode,
            createdBy: "human-1",
            redeemedBy: null,
            agentId: null,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    const appInstance = createRegistryApp();

    const redeemResponse = await appInstance.request(
      `http://host.docker.internal:8788${INVITES_REDEEM_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Invitee Alpha",
          apiKeyName: "primary-invite-key",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(redeemResponse.status).toBe(201);
    const redeemBody = (await redeemResponse.json()) as {
      human: {
        id: string;
        did: string;
        displayName: string;
        role: "admin" | "user";
        status: "active" | "suspended";
      };
      apiKey: {
        id: string;
        name: string;
        token: string;
      };
      proxyUrl: string;
    };
    expect(redeemBody.human.displayName).toBe("Invitee Alpha");
    expect(redeemBody.human.role).toBe("user");
    expect(redeemBody.apiKey.name).toBe("primary-invite-key");
    expect(redeemBody.apiKey.token.startsWith("clw_pat_")).toBe(true);
    expect(redeemBody.proxyUrl).toBe("http://host.docker.internal:8787");

    expect(humanInserts).toHaveLength(1);
    expect(apiKeyInserts).toHaveLength(1);
    expect(apiKeyInserts[0]?.human_id).toBe(redeemBody.human.id);
    expect(inviteUpdates).toHaveLength(1);
    expect(inviteRows[0]?.redeemedBy).toBe(redeemBody.human.id);

    const meResponse = await appInstance.request(
      "/v1/me",
      {
        headers: {
          Authorization: `Bearer ${redeemBody.apiKey.token}`,
        },
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(meResponse.status).toBe(200);
    const meBody = (await meResponse.json()) as {
      human: {
        id: string;
        displayName: string;
        role: "admin" | "user";
      };
    };
    expect(meBody.human.id).toBe(redeemBody.human.id);
    expect(meBody.human.displayName).toBe("Invitee Alpha");
    expect(meBody.human.role).toBe("user");
  });

  it("rolls back fallback mutations when api key insert fails", async () => {
    const { authRow } = await makeValidPatContext();
    const inviteCode = "clw_inv_fallback_rollback";
    const { database, humanRows, inviteRows } = createFakeDb([authRow], [], {
      failBeginTransaction: true,
      failApiKeyInsertCount: 1,
      inviteRows: [
        {
          id: generateUlid(1700700003000),
          code: inviteCode,
          createdBy: "human-1",
          redeemedBy: null,
          agentId: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const appInstance = createRegistryApp();

    const firstResponse = await appInstance.request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Fallback Invitee",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(firstResponse.status).toBe(500);
    expect(humanRows).toHaveLength(1);
    expect(inviteRows[0]?.redeemedBy).toBeNull();

    const secondResponse = await appInstance.request(
      INVITES_REDEEM_PATH,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Fallback Invitee",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(secondResponse.status).toBe(201);
    expect(humanRows).toHaveLength(2);
    expect(inviteRows[0]?.redeemedBy).toEqual(expect.any(String));
  });

  it("returns caller-facing proxy URL when invite redeem runtime uses loopback", async () => {
    const inviteCode = "clw_inv_local_proxy";
    const { database } = createFakeDb([], [], {
      inviteRows: [
        {
          id: generateUlid(1700700003100),
          code: inviteCode,
          createdBy: "human-1",
          redeemedBy: null,
          agentId: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const response = await createRegistryApp().request(
      "https://dev.registry.clawdentity.com/v1/invites/redeem",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "host.docker.internal:8788",
          "x-forwarded-host": "host.docker.internal:8788",
          "x-forwarded-proto": "http",
        },
        body: JSON.stringify({
          code: inviteCode,
          displayName: "Invitee Beta",
          apiKeyName: "invite-local",
        }),
      },
      {
        DB: database,
        ENVIRONMENT: "local",
        PROXY_URL: "http://127.0.0.1:8787",
        BOOTSTRAP_INTERNAL_SERVICE_ID: "proxy-pairing",
        BOOTSTRAP_INTERNAL_SERVICE_SECRET: "bootstrap-test-secret",
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { proxyUrl: string };
    expect(body.proxyUrl).toBe("http://host.docker.internal:8787");
  });
});
