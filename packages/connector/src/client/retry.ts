export function computeJitteredBackoffDelayMs(input: {
  minDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  attempt: number;
  jitterRatio: number;
  random: () => number;
}): number {
  const exponentialDelay =
    input.minDelayMs * input.backoffFactor ** input.attempt;
  const boundedDelay = Math.min(exponentialDelay, input.maxDelayMs);
  const jitterRange = boundedDelay * input.jitterRatio;
  const jitterOffset =
    jitterRange === 0 ? 0 : (input.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.floor(boundedDelay + jitterOffset));
}

export function computeNextBackoffDelayMs(input: {
  currentDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}): number {
  return Math.min(
    input.maxDelayMs,
    Math.floor(input.currentDelayMs * input.backoffFactor),
  );
}
