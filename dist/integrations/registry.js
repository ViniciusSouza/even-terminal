export const REQUIRED_INTEGRATION_METHODS = [
    "listSessions",
    "getSessionStatus",
    "getInfo",
    "getHistory",
    "prompt",
    "respondPermission",
    "respondQuestion",
    "interrupt",
    "getStatus",
];
export class CliIntegrationRegistry {
    #integrations = new Map();
    register(plugin) {
        const { name, integration } = plugin;
        if (!name) {
            throw new Error("CLI integration name must not be empty");
        }
        if (this.#integrations.has(name)) {
            throw new Error(`CLI integration "${name}" is already registered`);
        }
        assertCliIntegration(name, integration);
        this.#integrations.set(name, integration);
        return this;
    }
    get(name) {
        const integration = this.#integrations.get(name);
        if (!integration) {
            throw new Error(`No CLI integration registered for "${name}"`);
        }
        return integration;
    }
    has(name) {
        return this.#integrations.has(name);
    }
    names() {
        return [...this.#integrations.keys()];
    }
}
export function assertCliIntegration(name, integration) {
    if (!integration || typeof integration !== "object") {
        throw new TypeError(`CLI integration "${name}" must be an object`);
    }
    for (const method of REQUIRED_INTEGRATION_METHODS) {
        if (typeof Reflect.get(integration, method) !== "function") {
            throw new TypeError(`CLI integration "${name}" must implement ${method}()`);
        }
    }
}
