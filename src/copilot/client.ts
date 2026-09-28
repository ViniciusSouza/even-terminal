import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
} from "@github/copilot-sdk";
import { readFileSync } from "node:fs";

export type CopilotClientLike = Pick<
  CopilotClient,
  | "createSession"
  | "resumeSession"
  | "listSessions"
  | "getStatus"
  | "getAuthStatus"
  | "listModels"
  | "start"
  | "stop"
>;

export type CopilotClientFactory = (
  options: CopilotClientOptions,
) => CopilotClientLike;

export interface CopilotClientManager {
  getClient(): Promise<CopilotClientLike>;
  stop(): Promise<Error[]>;
}

function clientOptions(): CopilotClientOptions {
  const cliPath = process.env.COPILOT_CLI_PATH?.trim();
  const tokenFile = process.env.COPILOT_GITHUB_TOKEN_FILE?.trim();
  let gitHubToken = process.env.COPILOT_GITHUB_TOKEN?.trim();
  if (tokenFile) {
    try {
      gitHubToken = readFileSync(tokenFile, "utf8").trim();
    } catch (error) {
      throw new Error(
        `Cannot read COPILOT_GITHUB_TOKEN_FILE "${tokenFile}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!gitHubToken) {
      throw new Error(`COPILOT_GITHUB_TOKEN_FILE "${tokenFile}" is empty`);
    }
  }
  return {
    mode: "copilot-cli",
    logLevel: process.env.EVEN_TERMINAL_DEBUG ? "debug" : "error",
    ...(gitHubToken ? { gitHubToken } : {}),
    ...(cliPath
      ? { connection: RuntimeConnection.forStdio({ path: cliPath }) }
      : {}),
  };
}

export function createCopilotClientManager(
  factory: CopilotClientFactory = (options) => new CopilotClient(options),
): CopilotClientManager {
  let client: CopilotClientLike | undefined;
  let starting: Promise<CopilotClientLike> | undefined;

  async function getClient(): Promise<CopilotClientLike> {
    if (client) {
      return client;
    }
    if (!starting) {
      starting = (async () => {
        const created = factory(clientOptions());
        client = created;
        try {
          await created.start();
          return created;
        } catch (error) {
          if (client === created) {
            client = undefined;
          }
          const cleanupErrors = await created.stop();
          if (cleanupErrors.length) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              "Copilot client startup and cleanup failed",
            );
          }
          throw error;
        }
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  async function stop(): Promise<Error[]> {
    const active = client;
    client = undefined;
    if (!active) {
      return [];
    }
    return active.stop();
  }

  return { getClient, stop };
}

export const copilotClientManager = createCopilotClientManager();

export function stopCopilotClient(): Promise<Error[]> {
  return copilotClientManager.stop();
}
