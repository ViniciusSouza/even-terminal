import {
  BUILT_IN_INTEGRATION_NAMES,
  type BuiltInIntegrationName,
} from "./integrations/contracts.js";

export const SUPPORTED_PROVIDERS = BUILT_IN_INTEGRATION_NAMES;

export function isProvider(value: unknown): value is BuiltInIntegrationName {
  return typeof value === "string"
    && SUPPORTED_PROVIDERS.includes(value as BuiltInIntegrationName);
}

export function parseProvider(
  value: unknown,
  label = "provider",
): BuiltInIntegrationName {
  if (isProvider(value)) {
    return value;
  }

  throw new Error(
    `Unsupported ${label} "${String(value)}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
  );
}

export function getDefaultProvider(): BuiltInIntegrationName {
  const env = process.env.DEFAULT_PROVIDER;
  if (!env) {
    return "claude";
  }

  return parseProvider(env, "DEFAULT_PROVIDER");
}
