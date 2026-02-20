function toDate(value: Date | string | number): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid datetime value: ${String(value)}`);
  }

  return parsed;
}

export function nowUtcMs(): number {
  return Date.now();
}

export function toIso(value: Date | string | number): string {
  return toDate(value).toISOString();
}

export function nowIso(): string {
  return toIso(nowUtcMs());
}

export function addSeconds(
  value: Date | string | number,
  seconds: number,
): string {
  const next = toDate(value).getTime() + seconds * 1000;
  return toIso(next);
}

export function isExpired(
  expiresAt: Date | string | number,
  reference: Date | string | number = Date.now(),
): boolean {
  return toDate(expiresAt).getTime() <= toDate(reference).getTime();
}
