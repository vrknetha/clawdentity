export const runtimeEnvironmentValues = [
  "development",
  "production",
  "test",
] as const;

export type RuntimeEnvironment = (typeof runtimeEnvironmentValues)[number];

export function shouldExposeVerboseErrors(
  environment: RuntimeEnvironment,
): boolean {
  return environment !== "production";
}
