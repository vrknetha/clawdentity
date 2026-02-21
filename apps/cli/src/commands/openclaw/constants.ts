import { createLogger } from "@clawdentity/sdk";

export const logger = createLogger({ service: "cli", module: "openclaw" });

export const AGENTS_DIR_NAME = "agents";
export const AIT_FILE_NAME = "ait.jwt";
export const SECRET_KEY_FILE_NAME = "secret.key";
export const PEERS_FILE_NAME = "peers.json";
export const OPENCLAW_DIR_NAME = ".openclaw";
export const OPENCLAW_CONFIG_FILE_NAME = "openclaw.json";
export const LEGACY_OPENCLAW_STATE_DIR_NAMES = [
  ".clawdbot",
  ".moldbot",
  ".moltbot",
] as const;
export const LEGACY_OPENCLAW_CONFIG_FILE_NAMES = [
  "clawdbot.json",
  "moldbot.json",
  "moltbot.json",
] as const;
export const OPENCLAW_AGENT_FILE_NAME = "openclaw-agent-name";
export const OPENCLAW_RELAY_RUNTIME_FILE_NAME = "openclaw-relay.json";
export const OPENCLAW_CONNECTORS_FILE_NAME = "openclaw-connectors.json";
export const SKILL_DIR_NAME = "clawdentity-openclaw-relay";
export const RELAY_MODULE_FILE_NAME = "relay-to-peer.mjs";
export const RELAY_RUNTIME_FILE_NAME = "clawdentity-relay.json";
export const RELAY_PEERS_FILE_NAME = "clawdentity-peers.json";
export const HOOK_MAPPING_ID = "clawdentity-send-to-peer";
export const HOOK_PATH_SEND_TO_PEER = "send-to-peer";
export const OPENCLAW_SEND_TO_PEER_HOOK_PATH = "hooks/send-to-peer";
export const DEFAULT_OPENCLAW_BASE_URL = "http://127.0.0.1:18789";
export const DEFAULT_OPENCLAW_MAIN_SESSION_KEY = "main";
export const DEFAULT_CONNECTOR_PORT = 19400;
export const DEFAULT_CONNECTOR_OUTBOUND_PATH = "/v1/outbound";
export const DEFAULT_CONNECTOR_STATUS_PATH = "/v1/status";
export const DEFAULT_SETUP_WAIT_TIMEOUT_SECONDS = 30;
export const CONNECTOR_HOST_LOOPBACK = "127.0.0.1";
export const CONNECTOR_HOST_DOCKER = "host.docker.internal";
export const CONNECTOR_HOST_DOCKER_GATEWAY = "gateway.docker.internal";
export const CONNECTOR_HOST_LINUX_BRIDGE = "172.17.0.1";
export const CONNECTOR_RUN_DIR_NAME = "run";
export const CONNECTOR_DETACHED_STDOUT_FILE_SUFFIX = "stdout.log";
export const CONNECTOR_DETACHED_STDERR_FILE_SUFFIX = "stderr.log";
export const INVITE_CODE_PREFIX = "clawd1_";
export const PEER_ALIAS_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const FILE_MODE = 0o600;
export const OPENCLAW_HOOK_TOKEN_BYTES = 32;
export const OPENCLAW_SETUP_COMMAND_HINT =
  "Run: clawdentity openclaw setup <agentName>";
export const OPENCLAW_SETUP_RESTART_COMMAND_HINT = `${OPENCLAW_SETUP_COMMAND_HINT} and restart OpenClaw`;
export const OPENCLAW_SETUP_WITH_BASE_URL_HINT = `${OPENCLAW_SETUP_COMMAND_HINT} --openclaw-base-url <url>`;
export const OPENCLAW_PAIRING_COMMAND_HINT =
  "Run QR pairing first: clawdentity pair start <agentName> --qr and clawdentity pair confirm <agentName> --qr-file <path>";
export const OPENCLAW_DEVICE_APPROVAL_RECOVERY_HINT =
  "Run: clawdentity openclaw setup <agentName> (auto-recovers pending OpenClaw gateway device approvals)";
export const OPENCLAW_GATEWAY_AUTH_RECOVERY_HINT =
  "Run: clawdentity openclaw setup <agentName> (ensures gateway auth mode/token are configured)";
export const OPENCLAW_GATEWAY_APPROVAL_COMMAND = "openclaw";
export const OPENCLAW_GATEWAY_APPROVAL_TIMEOUT_MS = 10_000;
export const OPENCLAW_SETUP_STABILITY_WINDOW_SECONDS = 20;
export const OPENCLAW_SETUP_STABILITY_POLL_INTERVAL_MS = 1_000;
