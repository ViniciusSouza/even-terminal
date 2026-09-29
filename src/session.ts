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

/**
 * Provider forced by `--force` (server-wide), or `null` when the client's
 * requested provider should be honored as usual.
 */
export function getForcedProvider(): BuiltInIntegrationName | null {
  const env = process.env.EVEN_TERMINAL_FORCE_PROVIDER;
  if (!env) {
    return null;
  }

  return parseProvider(env, "EVEN_TERMINAL_FORCE_PROVIDER");
}

/**
 * Resolves the provider to use for a request: the forced provider always
 * wins, otherwise the client-requested value, falling back to the default.
 */
export function resolveProviderName(value?: unknown): BuiltInIntegrationName {
  const forced = getForcedProvider();
  if (forced) {
    return forced;
  }

  return value !== undefined && value !== null && value !== ""
    ? parseProvider(value)
    : getDefaultProvider();
}
