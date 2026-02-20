export const runtimeEnvironmentValues = [
  "local",
  "development",
  "production",
] as const;

export type RuntimeEnvironment = (typeof runtimeEnvironmentValues)[number];

export function shouldExposeVerboseErrors(
  environment: RuntimeEnvironment,
): boolean {
  return environment !== "production";
}
