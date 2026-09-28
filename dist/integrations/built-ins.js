import { CliIntegrationRegistry } from "./registry.js";
export function createBuiltInIntegrationRegistry(options) {
    return new CliIntegrationRegistry()
        .register({
        name: "claude",
        integration: options.useOriginalClaude
            ? options.claude
            : options.claudeSync,
    })
        .register({
        name: "claude-sync",
        integration: options.claudeSync,
    })
        .register({
        name: "codex",
        integration: options.codex,
    });
}
