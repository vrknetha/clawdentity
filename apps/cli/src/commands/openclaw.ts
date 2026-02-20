export { createOpenclawCommand } from "./openclaw/command.js";

export { runOpenclawDoctor } from "./openclaw/doctor.js";
export {
  runOpenclawRelayTest,
  runOpenclawRelayWebsocketTest,
} from "./openclaw/relay.js";
export {
  createOpenclawInviteCode,
  decodeOpenclawInviteCode,
  setupOpenclawRelay,
  setupOpenclawRelayFromInvite,
  setupOpenclawSelfReady,
} from "./openclaw/setup.js";
export type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorResult,
  OpenclawInviteResult,
  OpenclawRelayTestResult,
  OpenclawRelayWebsocketTestResult,
  OpenclawSelfSetupResult,
  OpenclawSetupResult,
} from "./openclaw/types.js";
