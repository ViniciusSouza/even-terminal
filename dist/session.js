import { BUILT_IN_INTEGRATION_NAMES, } from "./integrations/contracts.js";
export const SUPPORTED_PROVIDERS = BUILT_IN_INTEGRATION_NAMES;
export function isProvider(value) {
    return typeof value === "string"
        && SUPPORTED_PROVIDERS.includes(value);
}
export function parseProvider(value, label = "provider") {
    if (isProvider(value)) {
        return value;
    }
    throw new Error(`Unsupported ${label} "${String(value)}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`);
}
export function getDefaultProvider() {
    const env = process.env.DEFAULT_PROVIDER;
    if (!env) {
        return "claude";
    }
    return parseProvider(env, "DEFAULT_PROVIDER");
}
