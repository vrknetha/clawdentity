import type { RelayDeliveryPolicy } from "./types.js";

export function computeRetryDelayMs(
  policy: RelayDeliveryPolicy,
  priorAttempts: number,
): number {
  const exponent = Math.max(0, priorAttempts - 1);
  const baseDelay = Math.min(
    policy.retryMaxMs,
    policy.retryInitialMs * 2 ** exponent,
  );

  if (policy.retryJitterRatio <= 0) {
    return baseDelay;
  }

  const jitterSpan = baseDelay * policy.retryJitterRatio;
  const lowerBound = Math.max(1, Math.floor(baseDelay - jitterSpan));
  const upperBound = Math.ceil(baseDelay + jitterSpan);
  const sample = lowerBound + Math.random() * (upperBound - lowerBound);
  return Math.min(policy.retryMaxMs, Math.floor(sample));
}
