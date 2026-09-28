import type {
  BuiltInIntegrationName,
  CliIntegration,
} from "./contracts.js";
import { CliIntegrationRegistry } from "./registry.js";

interface BuiltInIntegrationOptions {
  claude: CliIntegration;
  claudeSync: CliIntegration;
  codex: CliIntegration;
  useOriginalClaude: boolean;
}

export function createBuiltInIntegrationRegistry(
  options: BuiltInIntegrationOptions,
): CliIntegrationRegistry<BuiltInIntegrationName> {
  return new CliIntegrationRegistry<BuiltInIntegrationName>()
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
