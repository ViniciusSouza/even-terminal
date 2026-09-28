import { CopilotClient, RuntimeConnection, } from "@github/copilot-sdk";
function clientOptions() {
    const cliPath = process.env.COPILOT_CLI_PATH?.trim();
    return {
        mode: "copilot-cli",
        logLevel: process.env.EVEN_TERMINAL_DEBUG ? "debug" : "error",
        ...(cliPath
            ? { connection: RuntimeConnection.forStdio({ path: cliPath }) }
            : {}),
    };
}
export function createCopilotClientManager(factory = (options) => new CopilotClient(options)) {
    let client;
    let starting;
    async function getClient() {
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
                }
                catch (error) {
                    if (client === created) {
                        client = undefined;
                    }
                    const cleanupErrors = await created.stop();
                    if (cleanupErrors.length) {
                        throw new AggregateError([error, ...cleanupErrors], "Copilot client startup and cleanup failed");
                    }
                    throw error;
                }
            })().finally(() => {
                starting = undefined;
            });
        }
        return starting;
    }
    async function stop() {
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
export function stopCopilotClient() {
    return copilotClientManager.stop();
}
