# Clawdentity Logging Strategy

## Current State

### Logger Implementation
- Custom structured JSON logger (`@clawdentity/sdk` → `logging.ts`)
- Uses `console.log/info/warn/error/debug` → Cloudflare Workers Logs captures these
- Request logging middleware on every route (`request.completed` with method, path, status, durationMs)
- No log-level filtering — everything emits regardless of environment

### Log Events Inventory

**Proxy (15 events):**
| Event | Level | Frequency | Description |
|-------|-------|-----------|-------------|
| `proxy.auth.verified` | info | Every authenticated request | Auth pipeline passed |
| `proxy.hooks.agent.delivered_to_relay` | info | Every message relay | Message handed to DO |
| `proxy.hooks.agent.relay_delivery_failed` | warn | On delivery failure | DO rejected message |
| `proxy.hooks.agent.relay_queue_full` | warn | When queue saturated | Agent queue at capacity |
| `proxy.relay.connect` | info | Every WebSocket connect | Connector established WS |
| `proxy.pair.start` | info | On pairing initiation | Pairing ticket created |
| `proxy.pair.confirm` | info | On pairing confirmation | Trust pair established |
| `proxy.pair.status` | info | On status check | Ticket status queried |
| `proxy.pair.confirm.callback_failed` | warn | On callback failure | Peer notification failed |
| `proxy.rate_limit.exceeded` | warn | On agent rate limit | Agent throttled |
| `proxy.public_rate_limit.exceeded` | warn | On public rate limit | Public endpoint throttled |
| `proxy.relay.receipt_record_failed` | warn | On receipt write failure | Receipt persistence failed |
| `proxy.relay.receipt_lookup_failed` | warn | On receipt read failure | Receipt query failed |
| `proxy.trust_store.memory_fallback` | warn | On DO unavailable | Trust store degraded |
| `proxy.server_started` | info | Once on boot | Server initialization |
| `request.completed` | info | **Every single request** | Request logging middleware |

**Registry (4 events — very sparse):**
| Event | Level | Frequency | Description |
|-------|-------|-----------|-------------|
| `registry.event_bus.publish_failed` | warn | On queue publish failure | Event bus degraded |
| `registry.admin_bootstrap_rollback_failed` | error | On bootstrap failure | Critical setup error |
| `registry.invite_redeem_rollback_failed` | error | On invite failure | Invite transaction failed |
| `registry.agent_registration_rollback_failed` | error | On registration failure | Registration transaction failed |
| `request.completed` | info | **Every single request** | Request logging middleware |

**Connector (30 events — runs locally, not on CF):**
Connector runs as a Node.js sidecar on the user's machine. CF billing doesn't apply, but disk/stdout matters.

**Durable Objects (AgentRelaySession — 0 explicit log events):**
The DO has ZERO console.log calls. All logging happens in the proxy Worker before/after DO calls. However, Cloudflare still generates invocation logs for every DO alarm, fetch, and WebSocket message.

### Cost Drivers (Cloudflare Workers Logs)

Starting billing: Already active (since April 2025). Traces billing starts March 1, 2026.

| Plan | Included Events/Month | Overage |
|------|----------------------|---------|
| Free | 10M | Operations fail |
| Paid ($5/mo) | 20M | $0.60/million |

**What counts as an observability event:**
- Each `console.log/info/warn/error/debug` call = 1 event
- Each invocation log (auto-generated per request) = 1 event
- Each trace span = 1 event (from March 2026)
- `head_sampling_rate` controls what % of requests generate events

### Current Config (Both Services)
```json
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "invocation_logs": true,
    "head_sampling_rate": 1
  }
}
```
This logs 100% of everything. Fine for dev, expensive at scale.

---

## Logging Strategy

### Principle: Log decisions, not data flow

In production, log WHY something failed, not THAT something happened. A successful message relay is the norm — don't log it. A rejected message is an anomaly — always log it.

### Development Environment

**Goal:** Full visibility for debugging. Cost doesn't matter (low traffic).

```json
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "invocation_logs": true,
    "head_sampling_rate": 1
  }
}
```

**Logger level:** All levels (debug, info, warn, error) — no filtering.

**Request logging middleware:** Enabled (log every request with timing).

### Production Environment

**Goal:** Catch failures and anomalies. Minimize event count.

```json
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "invocation_logs": false,
    "head_sampling_rate": 1
  }
}
```

Why `head_sampling_rate: 1` but `invocation_logs: false`?
- Sampling rate controls whether a request generates ANY logs. At 0.1, you'd miss 90% of errors.
- `invocation_logs: false` disables the auto-generated invocation summary per request (the biggest event generator).
- Your custom `console.*` logs still fire at rate 1.0, so you see every error/warn.

**Logger level filtering:** Add environment-aware log level to the logger.

### Proposed Logger Changes

#### 1. Add minimum log level support

```typescript
// sdk/src/logging.ts
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(
  baseFields: LogFields = {},
  minLevel: LogLevel = "debug",
): Logger {
  const minPriority = LOG_LEVEL_PRIORITY[minLevel];
  const emit = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (LOG_LEVEL_PRIORITY[level] < minPriority) return;
    writeLine(level, toLogLine(level, message, fields, baseFields));
  };
  // ...
}
```

#### 2. Environment-based log levels

| Environment | Min Level | Effect |
|-------------|-----------|--------|
| local | debug | Everything |
| development | debug | Everything |
| production | warn | Only warn + error |

This eliminates ALL info-level logs in production:
- `proxy.auth.verified` — gone (normal operation)
- `proxy.hooks.agent.delivered_to_relay` — gone (normal operation)
- `proxy.relay.connect` — gone (normal operation)
- `proxy.pair.start/confirm/status` — gone (normal operation)
- `request.completed` — gone (the biggest volume killer)

What survives in production (warn + error only):
- `proxy.hooks.agent.relay_delivery_failed` — delivery failures
- `proxy.hooks.agent.relay_queue_full` — capacity issues
- `proxy.rate_limit.exceeded` — abuse detection
- `proxy.public_rate_limit.exceeded` — abuse detection
- `proxy.relay.receipt_record_failed` — data integrity
- `proxy.relay.receipt_lookup_failed` — data integrity
- `proxy.trust_store.memory_fallback` — degraded state
- `proxy.pair.confirm.callback_failed` — pairing issues
- All registry error events (rollback failures)

#### 3. Conditional request logging middleware

Only log slow or failed requests in production:

```typescript
export function createRequestLoggingMiddleware(
  logger: Logger,
  options?: { slowThresholdMs?: number; onlyErrors?: boolean },
) {
  const slowMs = options?.slowThresholdMs ?? 5000;
  const onlyErrors = options?.onlyErrors ?? false;

  return createMiddleware(async (c, next) => {
    const startedAt = nowUtcMs();
    let caughtError: unknown;
    try {
      await next();
    } catch (error) {
      caughtError = error;
      throw error;
    } finally {
      const durationMs = nowUtcMs() - startedAt;
      const status = caughtError ? 500 : c.res.status;
      const isError = status >= 400;
      const isSlow = durationMs >= slowMs;

      if (!onlyErrors || isError || isSlow) {
        logger.info("request.completed", {
          requestId: resolveRequestId(c.req.header(REQUEST_ID_HEADER)),
          method: c.req.method,
          path: c.req.path,
          status,
          durationMs,
          ...(isSlow ? { slow: true } : {}),
        });
      }
    }
  });
}
```

Production usage:
```typescript
app.use("*", createRequestLoggingMiddleware(logger, { onlyErrors: true, slowThresholdMs: 3000 }));
```

### Event Budget Estimation (Production)

**Scenario: 1,000 active agents, ~50 messages/agent/day**

Without this strategy (current):
| Source | Events/Day |
|--------|-----------|
| Invocation logs (auto) | ~50,000 |
| `request.completed` (every request) | ~50,000 |
| `proxy.auth.verified` (every request) | ~50,000 |
| `proxy.hooks.agent.delivered_to_relay` | ~50,000 |
| `proxy.relay.connect` (reconnects) | ~2,000 |
| DO alarms (heartbeats, retries) | ~100,000 |
| **Total** | **~300,000/day ≈ 9M/month** |

With this strategy:
| Source | Events/Day |
|--------|-----------|
| Invocation logs | 0 (disabled) |
| `request.completed` | ~500 (errors + slow only) |
| warn/error events | ~200 (failures only) |
| **Total** | **~700/day ≈ 21K/month** |

**Reduction: ~99.7%** — comfortably within free plan forever.

---

## Wrangler Config Changes

### Proxy

```jsonc
// Dev (keep as-is)
"dev": {
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "head_sampling_rate": 1
    }
  }
}

// Production
"production": {
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "invocation_logs": false,
      "head_sampling_rate": 1
    }
  }
}
```

### Registry

```jsonc
// Dev (keep as-is)
"dev": {
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "head_sampling_rate": 1
    }
  }
}

// Production (registry is low-traffic, can afford more logging)
"production": {
  "observability": {
    "enabled": true,
    "logs": {
      "enabled": true,
      "invocation_logs": true,
      "head_sampling_rate": 1
    }
  }
}
```

---

## Implementation Checklist

- [ ] Add `minLevel` parameter to `createLogger` in `@clawdentity/sdk`
- [ ] Pass `ENVIRONMENT` to logger creation in proxy and registry servers
- [ ] Set proxy production logger to `warn` level
- [ ] Set registry production logger to `warn` level
- [ ] Update request logging middleware to support `onlyErrors` mode
- [ ] Use `onlyErrors: true` for proxy production
- [ ] Keep full request logging for registry (low volume)
- [ ] Add per-environment observability config in wrangler.jsonc
- [ ] Disable `invocation_logs` for proxy production
- [ ] Keep `invocation_logs` enabled for registry production

---

## Future Considerations

- **Logpush to external sink:** If you need long-term log retention beyond CF dashboard (7 days), add Workers Logpush to S3/R2. Only worth it at scale.
- **Structured error codes:** All warn/error events already use structured keys (`proxy.hooks.agent.relay_queue_full`). Good for alerting rules later.
- **DO-level logging:** AgentRelaySession currently has zero logs. If you need delivery debugging in prod, add warn-level logs for queue overflow and retry exhaustion inside the DO itself.
- **Sampling fallback:** If warn/error volume ever gets high (DDoS, mass failures), add `head_sampling_rate: 0.1` as emergency circuit breaker.
