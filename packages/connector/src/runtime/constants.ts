export const REGISTRY_AUTH_FILENAME = "registry-auth.json";
export const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
export const AGENTS_DIR_NAME = "agents";
export const OUTBOUND_QUEUE_DIR_NAME = "outbound-queue";
export const OUTBOUND_QUEUE_FILENAME = "queue.json";
export const REFRESH_SINGLE_FLIGHT_PREFIX = "connector-runtime";
export const NONCE_SIZE = 16;
export const MAX_OUTBOUND_BODY_BYTES = 1024 * 1024;
export const ACCESS_TOKEN_REFRESH_SKEW_MS = 30_000;

export const CONNECTOR_DEAD_LETTER_PATH = "/v1/inbound/dead-letter";
export const CONNECTOR_DEAD_LETTER_REPLAY_PATH =
  "/v1/inbound/dead-letter/replay";
export const CONNECTOR_DEAD_LETTER_PURGE_PATH = "/v1/inbound/dead-letter/purge";
