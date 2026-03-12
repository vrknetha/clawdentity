export { createPairCommand } from "./pair/command.js";
export {
  confirmPairing,
  getPairingStatus,
  startPairing,
} from "./pair/service.js";
export type {
  PairCommandDependencies,
  PairConfirmOptions,
  PairConfirmResult,
  PairRequestOptions,
  PairStartOptions,
  PairStartResult,
  PairStatusOptions,
  PairStatusResult,
  PeerEntry,
  PeerProfile,
  PeersConfig,
} from "./pair/types.js";
