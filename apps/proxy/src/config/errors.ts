export class ProxyConfigError extends Error {
  readonly code = "CONFIG_VALIDATION_FAILED";
  readonly status = 500;
  readonly expose = true;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "ProxyConfigError";
    this.details = details;
  }
}

export function toConfigValidationError(
  details: Record<string, unknown>,
): ProxyConfigError {
  return new ProxyConfigError("Proxy configuration is invalid", details);
}
