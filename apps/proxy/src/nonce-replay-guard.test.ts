import { describe, expect, it } from "vitest";
import {
  NONCE_REPLAY_GUARD_ROUTES,
  NONCE_REPLAY_STORAGE_PREFIX,
} from "./nonce-replay-contract.js";
import { NonceReplayGuard } from "./nonce-replay-guard.js";

function createGuardHarness() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let transactionTail: Promise<void> = Promise.resolve();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        let deletedCount = 0;
        for (const key of keyOrKeys) {
          if (values.delete(key)) {
            deletedCount += 1;
          }
        }
        return deletedCount;
      }

      const deleted = values.delete(keyOrKeys);
      return deleted;
    },
    list: async (options?: { prefix?: string }) => {
      const listed = new Map<string, unknown>();
      for (const [key, value] of values.entries()) {
        if (
          typeof options?.prefix === "string" &&
          !key.startsWith(options.prefix)
        ) {
          continue;
        }

        listed.set(key, value);
      }
      return listed;
    },
    getAlarm: async () => alarmAt,
    setAlarm: async (scheduled: number | Date) => {
      alarmAt = scheduled instanceof Date ? scheduled.getTime() : scheduled;
    },
    deleteAlarm: async () => {
      alarmAt = null;
    },
    transaction: async <T>(
      closure: (txn: {
        get: (key: string) => Promise<unknown>;
        put: (key: string, value: unknown) => Promise<void>;
        getAlarm: () => Promise<number | null>;
        setAlarm: (scheduled: number | Date) => Promise<void>;
      }) => Promise<T>,
    ) => {
      const run = transactionTail.then(async () =>
        closure({
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => {
            values.set(key, value);
          },
          getAlarm: async () => alarmAt,
          setAlarm: async (scheduled: number | Date) => {
            alarmAt =
              scheduled instanceof Date ? scheduled.getTime() : scheduled;
          },
        }),
      );
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  const guard = new NonceReplayGuard({
    storage,
  } as unknown as DurableObjectState);

  return {
    values,
    guard,
  };
}

function buildTryAcceptRequest(payload: unknown): Request {
  return new Request(
    `https://nonce-replay-guard${NONCE_REPLAY_GUARD_ROUTES.tryAccept}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
}

describe("NonceReplayGuard", () => {
  it("accepts first nonce and rejects replay within ttl", async () => {
    const { guard } = createGuardHarness();
    const payload = {
      agentDid:
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-guard-1",
      ttlMs: 300_000,
      nowMs: 1_000,
    };

    const firstResponse = await guard.fetch(buildTryAcceptRequest(payload));
    const secondResponse = await guard.fetch(buildTryAcceptRequest(payload));

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await firstResponse.json()).toMatchObject({
      accepted: true,
      seenAt: 1_000,
      expiresAt: 301_000,
    });
    expect(await secondResponse.json()).toMatchObject({
      accepted: false,
      reason: "replay",
      seenAt: 1_000,
      expiresAt: 301_000,
    });
  });

  it("accepts nonce again after expiry and alarm cleanup", async () => {
    const { guard, values } = createGuardHarness();
    const payload = {
      agentDid:
        "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
      nonce: "nonce-guard-2",
      ttlMs: 1,
      nowMs: 0,
    };

    const firstResponse = await guard.fetch(buildTryAcceptRequest(payload));
    expect(firstResponse.status).toBe(200);
    expect(values.size).toBeGreaterThan(0);

    await guard.alarm();
    expect(values.size).toBe(0);

    const secondResponse = await guard.fetch(
      buildTryAcceptRequest({
        ...payload,
        nowMs: 10,
      }),
    );
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      accepted: true,
      seenAt: 10,
      expiresAt: 11,
    });
  });

  it("rejects invalid input with structured 400 error", async () => {
    const { guard } = createGuardHarness();
    const response = await guard.fetch(
      buildTryAcceptRequest({
        agentDid: "",
        nonce: "nonce-invalid",
        ttlMs: 300_000,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "NONCE_REPLAY_GUARD_INVALID_INPUT",
        message: "Nonce replay guard input is invalid",
      },
    });
  });

  it("cleans malformed durable entries during alarm sweep", async () => {
    const { guard, values } = createGuardHarness();
    values.set(`${NONCE_REPLAY_STORAGE_PREFIX}bad-entry`, {
      malformed: true,
    });

    await guard.alarm();

    expect(values.size).toBe(0);
  });

  it("accepts only one request when the same nonce races in parallel", async () => {
    const { guard } = createGuardHarness();
    const requestCount = 100;

    const responses = await Promise.all(
      Array.from({ length: requestCount }, () =>
        guard.fetch(
          buildTryAcceptRequest({
            agentDid:
              "did:cdi:registry.clawdentity.com:agent:01HF7YAT00W6W7CM7N3W5FDXT4",
            nonce: "nonce-race-1",
            ttlMs: 300_000,
            nowMs: 10_000,
          }),
        ),
      ),
    );
    const payloads = await Promise.all(
      responses.map(async (response) => response.json()),
    );

    const acceptedCount = payloads.filter(
      (payload) =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { accepted?: unknown }).accepted === true,
    ).length;
    const replayCount = payloads.filter(
      (payload) =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { accepted?: unknown; reason?: unknown }).accepted ===
          false &&
        (payload as { reason?: unknown }).reason === "replay",
    ).length;

    expect(acceptedCount).toBe(1);
    expect(replayCount).toBe(requestCount - 1);
  });
});
