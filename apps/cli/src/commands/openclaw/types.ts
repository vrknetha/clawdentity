import type { resolveConfig } from "../../config/manager.js";

export type OpenclawInvitePayload = {
  v: 1;
  issuedAt: string;
  did: string;
  proxyUrl: string;
  alias?: string;
  agentName?: string;
  humanName?: string;
};

export type OpenclawInviteOptions = {
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  agentName?: string;
  humanName?: string;
};

export type OpenclawSetupOptions = {
  inviteCode?: string;
  openclawDir?: string;
  transformSource?: string;
  openclawBaseUrl?: string;
  runtimeMode?: string;
  waitTimeoutSeconds?: string;
  noRuntimeStart?: boolean;
  homeDir?: string;
  gatewayDeviceApprovalRunner?: OpenclawGatewayDeviceApprovalRunner;
};

export type OpenclawDoctorOptions = {
  homeDir?: string;
  openclawDir?: string;
  peerAlias?: string;
  resolveConfigImpl?: typeof resolveConfig;
  fetchImpl?: typeof fetch;
  includeConfigCheck?: boolean;
  includeConnectorRuntimeCheck?: boolean;
  json?: boolean;
};

export type OpenclawDoctorCommandOptions = {
  peer?: string;
  openclawDir?: string;
  json?: boolean;
};

export type OpenclawSetupCommandOptions = {
  openclawDir?: string;
  transformSource?: string;
  openclawBaseUrl?: string;
  runtimeMode?: string;
  waitTimeoutSeconds?: string;
  noRuntimeStart?: boolean;
};

export type OpenclawRelayTestOptions = {
  peer?: string;
  homeDir?: string;
  openclawDir?: string;
  openclawBaseUrl?: string;
  hookToken?: string;
  sessionId?: string;
  message?: string;
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: typeof resolveConfig;
  json?: boolean;
};

export type OpenclawRelayWebsocketTestOptions = {
  peer?: string;
  homeDir?: string;
  openclawDir?: string;
  fetchImpl?: typeof fetch;
  resolveConfigImpl?: typeof resolveConfig;
  json?: boolean;
};

export type OpenclawGatewayDeviceApprovalInput = {
  requestId: string;
  openclawDir: string;
  openclawConfigPath: string;
};

export type OpenclawGatewayDeviceApprovalExecution = {
  ok: boolean;
  unavailable?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
};

export type OpenclawGatewayDeviceApprovalRunner = (
  input: OpenclawGatewayDeviceApprovalInput,
) => Promise<OpenclawGatewayDeviceApprovalExecution>;

export type OpenclawGatewayDeviceApprovalAttempt = {
  requestId: string;
  ok: boolean;
  unavailable: boolean;
  reason?: string;
  exitCode?: number;
};

export type OpenclawGatewayDeviceApprovalSummary = {
  gatewayDevicePendingPath: string;
  pendingRequestIds: string[];
  attempts: OpenclawGatewayDeviceApprovalAttempt[];
};

export type PeerEntry = {
  did: string;
  proxyUrl: string;
  agentName?: string;
  humanName?: string;
};

export type PeersConfig = {
  peers: Record<string, PeerEntry>;
};

export type OpenclawInviteResult = {
  code: string;
  did: string;
  proxyUrl: string;
  peerAlias?: string;
  agentName?: string;
  humanName?: string;
};

export type OpenclawSetupResult = {
  openclawConfigPath: string;
  transformTargetPath: string;
  relayTransformRuntimePath: string;
  relayTransformPeersPath: string;
  openclawBaseUrl: string;
  connectorBaseUrl: string;
  relayRuntimeConfigPath: string;
  openclawConfigChanged: boolean;
};

export type OpenclawRuntimeMode = "auto" | "service" | "detached";

export type OpenclawRuntimeResult = {
  runtimeMode: "none" | "service" | "detached" | "existing";
  runtimeStatus: "running" | "skipped";
  websocketStatus: "connected" | "skipped";
  connectorStatusUrl?: string;
};

export type OpenclawSelfSetupResult = OpenclawSetupResult &
  OpenclawRuntimeResult;

export type OpenclawRelayRuntimeConfig = {
  openclawBaseUrl: string;
  openclawHookToken?: string;
  relayTransformPeersPath?: string;
  updatedAt?: string;
};

export type ConnectorAssignmentEntry = {
  connectorBaseUrl: string;
  updatedAt: string;
};

export type ConnectorAssignmentsConfig = {
  agents: Record<string, ConnectorAssignmentEntry>;
};

export type OpenclawDoctorCheckId =
  | "config.registry"
  | "state.selectedAgent"
  | "state.credentials"
  | "state.peers"
  | "state.transform"
  | "state.hookMapping"
  | "state.hookToken"
  | "state.hookSessionRouting"
  | "state.gatewayAuth"
  | "state.gatewayDevicePairing"
  | "state.openclawBaseUrl"
  | "state.connectorRuntime"
  | "state.connectorInboundInbox"
  | "state.openclawHookHealth";

export type OpenclawDoctorCheckStatus = "pass" | "fail";

export type OpenclawDoctorCheckResult = {
  id: OpenclawDoctorCheckId;
  label: string;
  status: OpenclawDoctorCheckStatus;
  message: string;
  remediationHint?: string;
  details?: Record<string, unknown>;
};

export type OpenclawDoctorResult = {
  status: "healthy" | "unhealthy";
  checkedAt: string;
  checks: OpenclawDoctorCheckResult[];
};

export type OpenclawRelayTestResult = {
  status: "success" | "failure";
  checkedAt: string;
  peerAlias: string;
  endpoint: string;
  message: string;
  httpStatus?: number;
  remediationHint?: string;
  details?: Record<string, unknown>;
  preflight?: OpenclawDoctorResult;
};

export type OpenclawRelayWebsocketTestResult = {
  status: "success" | "failure";
  checkedAt: string;
  peerAlias: string;
  message: string;
  connectorBaseUrl?: string;
  connectorStatusUrl?: string;
  remediationHint?: string;
  details?: Record<string, unknown>;
  preflight?: OpenclawDoctorResult;
};

export type OpenclawGatewayPendingState =
  | {
      status: "missing";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "invalid";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "unreadable";
      gatewayDevicePendingPath: string;
    }
  | {
      status: "ok";
      gatewayDevicePendingPath: string;
      pendingRequestIds: string[];
    };

export type ConnectorHealthStatus = {
  connected: boolean;
  inboundInbox?: {
    deadLetterBytes?: number;
    deadLetterCount?: number;
    oldestDeadLetterAt?: string;
    lastReplayAt?: string;
    lastReplayError?: string;
    nextAttemptAt?: string;
    oldestPendingAt?: string;
    pendingBytes?: number;
    pendingCount?: number;
    replayerActive?: boolean;
  };
  openclawHook?: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url?: string;
  };
  reachable: boolean;
  statusUrl: string;
  reason?: string;
};

export type ParsedConnectorStatusPayload = {
  inboundInbox?: {
    deadLetterBytes?: number;
    deadLetterCount?: number;
    oldestDeadLetterAt?: string;
    lastReplayAt?: string;
    lastReplayError?: string;
    nextAttemptAt?: string;
    oldestPendingAt?: string;
    pendingBytes?: number;
    pendingCount?: number;
    replayerActive?: boolean;
  };
  openclawHook?: {
    lastAttemptAt?: string;
    lastAttemptStatus?: "ok" | "failed";
    url?: string;
  };
  websocketConnected: boolean;
};
