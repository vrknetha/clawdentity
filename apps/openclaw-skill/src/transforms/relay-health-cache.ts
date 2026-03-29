type EndpointHealthCacheEntry = {
  checkedAtMs: number;
  healthy: boolean;
};

const endpointHealthCache = new Map<string, EndpointHealthCacheEntry>();
const MAX_CONNECTOR_HEALTH_CACHE_ENTRIES = 256;

function pruneEndpointHealthCache(
  nowMs: number,
  healthCacheTtlMs: number,
): void {
  for (const [statusUrl, entry] of endpointHealthCache.entries()) {
    if (nowMs - entry.checkedAtMs >= healthCacheTtlMs) {
      endpointHealthCache.delete(statusUrl);
    }
  }

  if (endpointHealthCache.size <= MAX_CONNECTOR_HEALTH_CACHE_ENTRIES) {
    return;
  }

  const sortedByAge = [...endpointHealthCache.entries()].sort(
    (a, b) => a[1].checkedAtMs - b[1].checkedAtMs,
  );
  const overflowCount =
    endpointHealthCache.size - MAX_CONNECTOR_HEALTH_CACHE_ENTRIES;
  for (const [statusUrl] of sortedByAge.slice(0, overflowCount)) {
    endpointHealthCache.delete(statusUrl);
  }
}

export function readEndpointHealthCache(input: {
  healthCacheTtlMs: number;
  nowMs: number;
  statusUrl: string;
}): boolean | undefined {
  pruneEndpointHealthCache(input.nowMs, input.healthCacheTtlMs);
  const cacheEntry = endpointHealthCache.get(input.statusUrl);
  if (
    cacheEntry !== undefined &&
    input.nowMs - cacheEntry.checkedAtMs < input.healthCacheTtlMs
  ) {
    return cacheEntry.healthy;
  }

  return undefined;
}

export function writeEndpointHealthCache(input: {
  checkedAtMs: number;
  healthCacheTtlMs: number;
  healthy: boolean;
  statusUrl: string;
}): void {
  pruneEndpointHealthCache(input.checkedAtMs, input.healthCacheTtlMs);
  endpointHealthCache.set(input.statusUrl, {
    checkedAtMs: input.checkedAtMs,
    healthy: input.healthy,
  });
}
