import { computeJitteredBackoffDelayMs } from "./retry.js";

type ConnectorReconnectSchedulerOptions = {
  minDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterRatio: number;
  random: () => number;
  onSchedule: () => void;
  onReconnect: () => void;
};

export class ConnectorReconnectScheduler {
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffFactor: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly onSchedule: () => void;
  private readonly onReconnect: () => void;

  private attempt = 0;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ConnectorReconnectSchedulerOptions) {
    this.minDelayMs = options.minDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.backoffFactor = options.backoffFactor;
    this.jitterRatio = options.jitterRatio;
    this.random = options.random;
    this.onSchedule = options.onSchedule;
    this.onReconnect = options.onReconnect;
  }

  schedule(options?: { delayMs?: number; incrementAttempt?: boolean }): void {
    this.clear();

    let delayMs: number;
    if (options?.delayMs !== undefined) {
      delayMs = Math.max(0, Math.floor(options.delayMs));
    } else {
      delayMs = computeJitteredBackoffDelayMs({
        minDelayMs: this.minDelayMs,
        maxDelayMs: this.maxDelayMs,
        backoffFactor: this.backoffFactor,
        attempt: this.attempt,
        jitterRatio: this.jitterRatio,
        random: this.random,
      });
    }

    if (options?.incrementAttempt ?? true) {
      this.attempt += 1;
    }

    this.onSchedule();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      this.onReconnect();
    }, delayMs);
  }

  clear(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  resetAttempts(): void {
    this.attempt = 0;
  }
}
