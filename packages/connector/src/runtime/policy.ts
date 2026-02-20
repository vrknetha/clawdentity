import {
  DEFAULT_CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS,
  DEFAULT_CONNECTOR_INBOUND_EVENTS_MAX_BYTES,
  DEFAULT_CONNECTOR_INBOUND_EVENTS_MAX_FILES,
  DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_BYTES,
  DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_MESSAGES,
  DEFAULT_CONNECTOR_INBOUND_REPLAY_BATCH_SIZE,
  DEFAULT_CONNECTOR_INBOUND_REPLAY_INTERVAL_MS,
  DEFAULT_CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR,
  DEFAULT_CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS,
  DEFAULT_CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS,
  DEFAULT_CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS,
  DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_MAX_ATTEMPTS,
  DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_BACKOFF_FACTOR,
  DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_MAX_DELAY_MS,
} from "../constants.js";
import { parsePositiveIntEnv } from "./parse.js";
import type { InboundReplayPolicy, OpenclawProbePolicy } from "./types.js";

export function loadInboundReplayPolicy(): InboundReplayPolicy {
  const retryBackoffFactor = Number.parseFloat(
    process.env.CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR ?? "",
  );
  const runtimeReplayRetryBackoffFactor = Number.parseFloat(
    process.env.CONNECTOR_RUNTIME_REPLAY_RETRY_BACKOFF_FACTOR ?? "",
  );

  return {
    deadLetterNonRetryableMaxAttempts: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS",
      DEFAULT_CONNECTOR_INBOUND_DEAD_LETTER_NON_RETRYABLE_MAX_ATTEMPTS,
    ),
    eventsMaxBytes: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_EVENTS_MAX_BYTES",
      DEFAULT_CONNECTOR_INBOUND_EVENTS_MAX_BYTES,
    ),
    eventsMaxFiles: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_EVENTS_MAX_FILES",
      DEFAULT_CONNECTOR_INBOUND_EVENTS_MAX_FILES,
    ),
    inboxMaxMessages: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_INBOX_MAX_MESSAGES",
      DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_MESSAGES,
    ),
    inboxMaxBytes: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_INBOX_MAX_BYTES",
      DEFAULT_CONNECTOR_INBOUND_INBOX_MAX_BYTES,
    ),
    replayIntervalMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_REPLAY_INTERVAL_MS",
      DEFAULT_CONNECTOR_INBOUND_REPLAY_INTERVAL_MS,
    ),
    batchSize: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_REPLAY_BATCH_SIZE",
      DEFAULT_CONNECTOR_INBOUND_REPLAY_BATCH_SIZE,
    ),
    retryInitialDelayMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS",
      DEFAULT_CONNECTOR_INBOUND_RETRY_INITIAL_DELAY_MS,
    ),
    retryMaxDelayMs: parsePositiveIntEnv(
      "CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS",
      DEFAULT_CONNECTOR_INBOUND_RETRY_MAX_DELAY_MS,
    ),
    retryBackoffFactor:
      Number.isFinite(retryBackoffFactor) && retryBackoffFactor >= 1
        ? retryBackoffFactor
        : DEFAULT_CONNECTOR_INBOUND_RETRY_BACKOFF_FACTOR,
    runtimeReplayMaxAttempts: parsePositiveIntEnv(
      "CONNECTOR_RUNTIME_REPLAY_MAX_ATTEMPTS",
      DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_MAX_ATTEMPTS,
    ),
    runtimeReplayRetryInitialDelayMs: parsePositiveIntEnv(
      "CONNECTOR_RUNTIME_REPLAY_RETRY_INITIAL_DELAY_MS",
      DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_INITIAL_DELAY_MS,
    ),
    runtimeReplayRetryMaxDelayMs: parsePositiveIntEnv(
      "CONNECTOR_RUNTIME_REPLAY_RETRY_MAX_DELAY_MS",
      DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_MAX_DELAY_MS,
    ),
    runtimeReplayRetryBackoffFactor:
      Number.isFinite(runtimeReplayRetryBackoffFactor) &&
      runtimeReplayRetryBackoffFactor >= 1
        ? runtimeReplayRetryBackoffFactor
        : DEFAULT_CONNECTOR_RUNTIME_REPLAY_DELIVER_RETRY_BACKOFF_FACTOR,
  };
}

export function loadOpenclawProbePolicy(): OpenclawProbePolicy {
  return {
    intervalMs: parsePositiveIntEnv(
      "CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS",
      DEFAULT_CONNECTOR_OPENCLAW_PROBE_INTERVAL_MS,
    ),
    timeoutMs: parsePositiveIntEnv(
      "CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS",
      DEFAULT_CONNECTOR_OPENCLAW_PROBE_TIMEOUT_MS,
    ),
  };
}

export function computeReplayDelayMs(input: {
  attemptCount: number;
  policy: InboundReplayPolicy;
}): number {
  const exponent = Math.max(0, input.attemptCount - 1);
  const delay = Math.min(
    input.policy.retryMaxDelayMs,
    Math.floor(
      input.policy.retryInitialDelayMs *
        input.policy.retryBackoffFactor ** exponent,
    ),
  );
  return Math.max(1, delay);
}

export function computeRuntimeReplayRetryDelayMs(input: {
  attemptCount: number;
  policy: InboundReplayPolicy;
}): number {
  const exponent = Math.max(0, input.attemptCount - 1);
  const delay = Math.min(
    input.policy.runtimeReplayRetryMaxDelayMs,
    Math.floor(
      input.policy.runtimeReplayRetryInitialDelayMs *
        input.policy.runtimeReplayRetryBackoffFactor ** exponent,
    ),
  );
  return Math.max(1, delay);
}
