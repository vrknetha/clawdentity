function toDate(value: Date | string | number): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid datetime value: ${String(value)}`);
  }

  return parsed;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(
  value: Date | string | number,
  seconds: number,
): string {
  const next = new Date(toDate(value).getTime() + seconds * 1000);
  return next.toISOString();
}

export function isExpired(
  expiresAt: Date | string | number,
  reference: Date | string | number = Date.now(),
): boolean {
  return toDate(expiresAt).getTime() <= toDate(reference).getTime();
}
