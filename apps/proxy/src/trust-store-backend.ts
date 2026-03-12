import { ProxyConfigError, type ProxyEnvironment } from "./config.js";
import {
  createDurableProxyTrustStore,
  createInMemoryProxyTrustStore,
  type ProxyTrustStateNamespace,
  type ProxyTrustStore,
} from "./proxy-trust-store.js";

export type ProxyTrustStoreBackend = "durable" | "memory";

type RuntimeTarget = "worker" | "node";

type ProxyTrustStoreResolution = {
  backend: ProxyTrustStoreBackend;
  trustStore: ProxyTrustStore;
};

function requiresDurableTrustStore(environment: ProxyEnvironment): boolean {
  return environment === "development" || environment === "production";
}

function toMissingDurableTrustStoreError(input: {
  environment: ProxyEnvironment;
  runtime: RuntimeTarget;
}): ProxyConfigError {
  const runtimeHint =
    input.runtime === "worker"
      ? "Ensure PROXY_TRUST_STATE Durable Object binding is configured for this environment."
      : "Node runtime supports local in-memory trust only. Use Worker runtime with PROXY_TRUST_STATE for non-local environments.";
  return new ProxyConfigError("Proxy configuration is invalid", {
    fieldErrors: {
      PROXY_TRUST_STATE: [
        `PROXY_TRUST_STATE is required when ENVIRONMENT is '${input.environment}'. ${runtimeHint}`,
      ],
    },
    formErrors: [],
  });
}

export function resolveWorkerTrustStore(input: {
  environment: ProxyEnvironment;
  trustStateNamespace?: ProxyTrustStateNamespace;
}): ProxyTrustStoreResolution {
  if (input.trustStateNamespace !== undefined) {
    return {
      backend: "durable",
      trustStore: createDurableProxyTrustStore(input.trustStateNamespace),
    };
  }

  if (requiresDurableTrustStore(input.environment)) {
    throw toMissingDurableTrustStoreError({
      environment: input.environment,
      runtime: "worker",
    });
  }

  return {
    backend: "memory",
    trustStore: createInMemoryProxyTrustStore(),
  };
}

export function resolveNodeTrustStore(input: {
  environment: ProxyEnvironment;
}): ProxyTrustStoreResolution {
  if (requiresDurableTrustStore(input.environment)) {
    throw toMissingDurableTrustStoreError({
      environment: input.environment,
      runtime: "node",
    });
  }

  return {
    backend: "memory",
    trustStore: createInMemoryProxyTrustStore(),
  };
}
