import { writeStdoutLine } from "../../io.js";
import { OPENCLAW_SEND_TO_PEER_HOOK_PATH } from "./constants.js";
import type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorResult,
  OpenclawRelayTestResult,
  OpenclawRelayWebsocketTestResult,
} from "./types.js";

export function formatDoctorCheckLine(
  check: OpenclawDoctorCheckResult,
): string {
  const icon = check.status === "pass" ? "✅" : "❌";
  return `${icon} ${check.label}: ${check.message}`;
}

export function printDoctorResult(result: OpenclawDoctorResult): void {
  writeStdoutLine(`OpenClaw doctor status: ${result.status}`);
  for (const check of result.checks) {
    writeStdoutLine(formatDoctorCheckLine(check));
    if (check.status === "fail" && check.remediationHint) {
      writeStdoutLine(`Fix: ${check.remediationHint}`);
    }
  }
}

export function printRelayTestResult(result: OpenclawRelayTestResult): void {
  writeStdoutLine(`Relay test status: ${result.status}`);
  writeStdoutLine(`Peer alias: ${result.peerAlias}`);
  writeStdoutLine(`Endpoint: ${result.endpoint}`);
  if (typeof result.httpStatus === "number") {
    writeStdoutLine(`HTTP status: ${result.httpStatus}`);
  }
  writeStdoutLine(`Message: ${result.message}`);
  if (result.remediationHint) {
    writeStdoutLine(`Fix: ${result.remediationHint}`);
  }
}

export function printRelayWebsocketTestResult(
  result: OpenclawRelayWebsocketTestResult,
): void {
  writeStdoutLine(`Relay websocket test status: ${result.status}`);
  writeStdoutLine(`Peer alias: ${result.peerAlias}`);
  if (typeof result.connectorBaseUrl === "string") {
    writeStdoutLine(`Connector base URL: ${result.connectorBaseUrl}`);
  }
  if (typeof result.connectorStatusUrl === "string") {
    writeStdoutLine(`Connector status URL: ${result.connectorStatusUrl}`);
  }
  writeStdoutLine(`Message: ${result.message}`);
  if (result.remediationHint) {
    writeStdoutLine(`Fix: ${result.remediationHint}`);
  }
}

export function toSendToPeerEndpoint(openclawBaseUrl: string): string {
  const normalizedBase = openclawBaseUrl.endsWith("/")
    ? openclawBaseUrl
    : `${openclawBaseUrl}/`;
  return new URL(OPENCLAW_SEND_TO_PEER_HOOK_PATH, normalizedBase).toString();
}
