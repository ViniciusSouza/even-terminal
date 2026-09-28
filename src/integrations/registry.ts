import type {
  CliIntegration,
  NamedCliIntegration,
} from "./contracts.js";

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
] as const satisfies readonly (keyof CliIntegration)[];

export class CliIntegrationRegistry<Name extends string = string> {
  readonly #integrations = new Map<Name, CliIntegration>();

  register(plugin: NamedCliIntegration<Name>): this {
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

  get(name: Name): CliIntegration {
    const integration = this.#integrations.get(name);
    if (!integration) {
      throw new Error(`No CLI integration registered for "${name}"`);
    }
    return integration;
  }

  has(name: Name): boolean {
    return this.#integrations.has(name);
  }

  names(): Name[] {
    return [...this.#integrations.keys()];
  }
}

export function assertCliIntegration(
  name: string,
  integration: unknown,
): asserts integration is CliIntegration {
  if (!integration || typeof integration !== "object") {
    throw new TypeError(`CLI integration "${name}" must be an object`);
  }

  for (const method of REQUIRED_INTEGRATION_METHODS) {
    if (typeof Reflect.get(integration, method) !== "function") {
      throw new TypeError(
        `CLI integration "${name}" must implement ${method}()`,
      );
    }
  }
}
