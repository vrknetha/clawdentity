import type { Logger } from "@clawdentity/sdk";
import { nowIso } from "@clawdentity/sdk";
import { sanitizeErrorReason } from "./errors.js";
import type {
  OpenclawGatewayProbeStatus,
  OpenclawProbePolicy,
} from "./types.js";

export function createOpenclawGatewayProbeController(input: {
  fetchImpl: typeof fetch;
  isRuntimeStopping: () => boolean;
  logger: Logger;
  openclawGatewayProbeStatus: OpenclawGatewayProbeStatus;
  openclawProbePolicy: OpenclawProbePolicy;
  openclawProbeUrl: string;
  runtimeShutdownSignal: AbortSignal;
}): {
  probeOpenclawGateway: () => Promise<void>;
} {
  let openclawProbeInFlight = false;

  const probeOpenclawGateway = async (): Promise<void> => {
    if (input.isRuntimeStopping() || openclawProbeInFlight) {
      return;
    }

    openclawProbeInFlight = true;

    const checkedAt = nowIso();
    try {
      const timeoutSignal = AbortSignal.timeout(
        input.openclawProbePolicy.timeoutMs,
      );
      const signal = AbortSignal.any([
        input.runtimeShutdownSignal,
        timeoutSignal,
      ]);
      await input.fetchImpl(input.openclawProbeUrl, {
        method: "GET",
        signal,
      });
      input.openclawGatewayProbeStatus.reachable = true;
      input.openclawGatewayProbeStatus.lastCheckedAt = checkedAt;
      input.openclawGatewayProbeStatus.lastSuccessAt = checkedAt;
      input.openclawGatewayProbeStatus.lastFailureReason = undefined;
    } catch (error) {
      if (input.runtimeShutdownSignal.aborted) {
        return;
      }

      input.openclawGatewayProbeStatus.reachable = false;
      input.openclawGatewayProbeStatus.lastCheckedAt = checkedAt;
      input.openclawGatewayProbeStatus.lastFailureReason =
        sanitizeErrorReason(error);
    } finally {
      openclawProbeInFlight = false;
    }
  };

  return {
    probeOpenclawGateway,
  };
}
