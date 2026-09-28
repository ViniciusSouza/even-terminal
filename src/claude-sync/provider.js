/**
 * Claude Sync keeps the interactive terminal wrapper when one owns a session.
 * Every other session runs through the shared Claude Agent SDK backend.
 */
import { createClaudeSdkProvider } from "../claude/provider.js";
import { PROVIDER_NAME } from "./provider-name.js";
export function createClaudeSyncProvider(emit, transport) {
    const sdk = createClaudeSdkProvider(emit, PROVIDER_NAME);
    // A wrapper may claim an idle SDK session. It may not claim one while the
    // SDK is writing the same session transcript.
    transport.setBusyCheck((sessionId) => sdk.isBusy(sessionId));
    return {
        listSessions: sdk.listSessions,
        getSessionStatus: async (sessionId) => {
            const wrapped = transport.wrapped(sessionId);
            return wrapped?.status ?? sdk.getSessionStatus(sessionId);
        },
        getInfo: sdk.getInfo,
        getHistory: sdk.getHistory,
        respondPermission(sessionId, decision) {
            const wrapped = transport.wrapped(sessionId);
            return wrapped
                ? transport.respondPermission(sessionId, decision)
                : sdk.respondPermission(sessionId, decision);
        },
        respondQuestion(sessionId, answer) {
            const wrapped = transport.wrapped(sessionId);
            if (wrapped) {
                transport.respondQuestion(sessionId, answer);
                return;
            }
            sdk.respondQuestion(sessionId, answer);
        },
        interrupt(sessionId) {
            if (transport.has(sessionId)) {
                transport.sendInterrupt(sessionId);
                return;
            }
            sdk.interrupt(sessionId);
        },
        getStatus(sessionId) {
            const wrapped = transport.wrapped(sessionId);
            return wrapped
                ? { state: wrapped.status, provider: PROVIDER_NAME }
                : sdk.getStatus(sessionId);
        },
        async prompt(sessionId, text, cwd) {
            const wrapped = sessionId ? transport.wrapped(sessionId) : undefined;
            if (wrapped) {
                // UserPromptSubmit remains the source of user_prompt for wrapped turns.
                wrapped.submitPrompt(text);
                return { sessionId: sessionId, provider: PROVIDER_NAME };
            }
            return sdk.prompt(sessionId, text, cwd);
        },
    };
}
