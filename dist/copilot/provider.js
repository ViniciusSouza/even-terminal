import { randomUUID } from "node:crypto";
import { copilotClientManager, } from "./client.js";
import { CopilotSessionAdapter } from "./session.js";
import { getCopilotHistory, listCopilotSessions } from "./storage.js";
function sessionNotFound(sessionId) {
    return Object.assign(new Error(`Copilot session not found: ${sessionId}`), { statusCode: 404 });
}
function looksLikeMissingSession(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /session.*(?:not found|missing|unknown)|no session/i.test(message);
}
export function createCopilotProvider(emit, manager = copilotClientManager) {
    const sessions = new Map();
    const loadingSessions = new Map();
    async function attachSession(sdkSession, adapter) {
        adapter.attach(sdkSession);
        sessions.set(adapter.id, adapter);
        return adapter;
    }
    async function createSession(cwd) {
        const client = await manager.getClient();
        const sessionId = randomUUID();
        const adapter = new CopilotSessionAdapter(emit, sessionId);
        const sdkSession = await client.createSession({
            ...adapter.sessionConfig(cwd),
            sessionId,
        });
        return attachSession(sdkSession, adapter);
    }
    async function resumeSession(sessionId, cwd) {
        const existing = sessions.get(sessionId);
        if (existing) {
            return existing;
        }
        let loading = loadingSessions.get(sessionId);
        if (!loading) {
            loading = (async () => {
                const client = await manager.getClient();
                const adapter = new CopilotSessionAdapter(emit, sessionId);
                try {
                    const sdkSession = await client.resumeSession(sessionId, adapter.sessionConfig(cwd));
                    return attachSession(sdkSession, adapter);
                }
                catch (error) {
                    if (looksLikeMissingSession(error)) {
                        throw sessionNotFound(sessionId);
                    }
                    throw error;
                }
            })();
            loadingSessions.set(sessionId, loading);
        }
        try {
            return await loading;
        }
        finally {
            if (loadingSessions.get(sessionId) === loading) {
                loadingSessions.delete(sessionId);
            }
        }
    }
    async function prompt(sessionId, text, cwd) {
        const session = sessionId
            ? await resumeSession(sessionId, cwd)
            : await createSession(cwd);
        await session.run(text);
        return { sessionId: session.id, provider: "copilot" };
    }
    return {
        async listSessions(limit, cwd) {
            return listCopilotSessions(await manager.getClient(), limit, cwd);
        },
        async getSessionStatus(sessionId) {
            return sessions.get(sessionId)?.status ?? "idle";
        },
        async getInfo() {
            const client = await manager.getClient();
            const [status, auth] = await Promise.all([
                client.getStatus(),
                client.getAuthStatus(),
            ]);
            return {
                account: {
                    login: auth.login ?? "",
                    host: auth.host ?? "",
                    authType: auth.authType ?? "",
                    authenticated: auth.isAuthenticated,
                },
                model: process.env.COPILOT_MODEL?.trim() || "Auto",
                version: status.version || "Unknown",
                provider: "copilot",
            };
        },
        async getHistory(sessionId, limit) {
            const client = await manager.getClient();
            try {
                return await getCopilotHistory(client, sessionId, limit, sessions.get(sessionId)?.session);
            }
            catch (error) {
                if (looksLikeMissingSession(error)) {
                    throw sessionNotFound(sessionId);
                }
                throw error;
            }
        },
        prompt,
        respondPermission(sessionId, decision) {
            return sessions.get(sessionId)?.respondPermission(decision) ?? false;
        },
        respondQuestion(sessionId, answer) {
            return sessions.get(sessionId)?.respondQuestion(answer) ?? false;
        },
        async interrupt(sessionId) {
            await sessions.get(sessionId)?.interrupt();
        },
        getStatus(sessionId) {
            const session = sessions.get(sessionId);
            return session
                ? { state: session.status, provider: "copilot" }
                : null;
        },
    };
}
