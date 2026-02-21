import { resolveConfig } from "../../config/manager.js";
import { parseProxyUrl, toDoctorCheck } from "./common.js";
import type {
  OpenclawDoctorCheckResult,
  OpenclawDoctorOptions,
} from "./types.js";

export async function runDoctorConfigCheck(input: {
  options: OpenclawDoctorOptions;
  checks: OpenclawDoctorCheckResult[];
}): Promise<void> {
  if (input.options.includeConfigCheck === false) {
    return;
  }

  const resolveConfigImpl = input.options.resolveConfigImpl ?? resolveConfig;
  try {
    const resolvedConfig = await resolveConfigImpl();
    const envProxyUrl =
      typeof process.env.CLAWDENTITY_PROXY_URL === "string"
        ? process.env.CLAWDENTITY_PROXY_URL.trim()
        : "";
    if (
      typeof resolvedConfig.registryUrl !== "string" ||
      resolvedConfig.registryUrl.trim().length === 0
    ) {
      input.checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "registryUrl is missing",
          remediationHint:
            "Run: clawdentity config set registryUrl <REGISTRY_URL>",
        }),
      );
    } else if (
      typeof resolvedConfig.apiKey !== "string" ||
      resolvedConfig.apiKey.trim().length === 0
    ) {
      input.checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "apiKey is missing",
          remediationHint: "Run: clawdentity config set apiKey <API_KEY>",
        }),
      );
    } else if (envProxyUrl.length > 0) {
      let hasValidEnvProxyUrl = true;
      try {
        parseProxyUrl(envProxyUrl);
      } catch {
        hasValidEnvProxyUrl = false;
        input.checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "fail",
            message: "CLAWDENTITY_PROXY_URL is invalid",
            remediationHint:
              "Set CLAWDENTITY_PROXY_URL to a valid http(s) URL or unset it",
          }),
        );
      }

      if (hasValidEnvProxyUrl) {
        input.checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "pass",
            message:
              "registryUrl and apiKey are configured (proxy URL override is active via CLAWDENTITY_PROXY_URL)",
          }),
        );
      }
    } else if (
      typeof resolvedConfig.proxyUrl !== "string" ||
      resolvedConfig.proxyUrl.trim().length === 0
    ) {
      input.checks.push(
        toDoctorCheck({
          id: "config.registry",
          label: "CLI config",
          status: "fail",
          message: "proxyUrl is missing",
          remediationHint:
            "Run: clawdentity invite redeem <clw_inv_...> or clawdentity config init",
        }),
      );
    } else {
      let hasValidConfigProxyUrl = true;
      try {
        parseProxyUrl(resolvedConfig.proxyUrl);
      } catch {
        hasValidConfigProxyUrl = false;
        input.checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "fail",
            message: "proxyUrl is invalid",
            remediationHint:
              "Run: clawdentity invite redeem <clw_inv_...> or clawdentity config init",
          }),
        );
      }

      if (hasValidConfigProxyUrl) {
        input.checks.push(
          toDoctorCheck({
            id: "config.registry",
            label: "CLI config",
            status: "pass",
            message: "registryUrl, apiKey, and proxyUrl are configured",
          }),
        );
      }
    }
  } catch {
    input.checks.push(
      toDoctorCheck({
        id: "config.registry",
        label: "CLI config",
        status: "fail",
        message: "unable to resolve CLI config",
        remediationHint:
          "Run: clawdentity config init (or fix your CLI state config file)",
      }),
    );
  }
}
