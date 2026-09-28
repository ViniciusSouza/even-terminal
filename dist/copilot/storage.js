import { summarizeCopilotTool, summarizeCopilotToolResult } from "./summarize.js";
export function mapCopilotSession(metadata) {
    return {
        id: metadata.sessionId,
        title: (metadata.summary || "Copilot session").slice(0, 64),
        timestamp: metadata.modifiedTime.toISOString(),
        cwd: metadata.context?.workingDirectory || "",
        provider: "copilot",
        status: null,
    };
}
export async function listCopilotSessions(client, limit, cwd) {
    const sessions = await client.listSessions(cwd ? { workingDirectory: cwd } : undefined);
    return sessions
        .sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime())
        .slice(0, limit)
        .map(mapCopilotSession);
}
export function mapCopilotHistory(events, limit) {
    const messages = [];
    const tools = new Map();
    for (const event of events) {
        if (event.agentId) {
            continue;
        }
        switch (event.type) {
            case "user.message":
                if (event.data.content) {
                    messages.push({ role: "user", text: event.data.content });
                }
                break;
            case "assistant.message":
                if (event.data.content) {
                    messages.push({ role: "assistant", text: event.data.content });
                }
                break;
            case "tool.execution_start":
                tools.set(event.data.toolCallId, {
                    name: event.data.toolName,
                    summary: summarizeCopilotTool(event.data),
                    input: event.data.arguments,
                });
                break;
            case "tool.execution_complete": {
                const tool = tools.get(event.data.toolCallId);
                messages.push({
                    role: "tool",
                    text: summarizeCopilotToolResult(event.data),
                    name: tool?.name || "Tool",
                    summary: tool?.summary || tool?.name || "Tool",
                    success: event.data.success,
                });
                break;
            }
        }
    }
    return messages.slice(-Math.min(limit, 10));
}
export async function getCopilotHistory(client, sessionId, limit, activeSession) {
    if (activeSession) {
        return mapCopilotHistory(await activeSession.getEvents(), limit);
    }
    const session = await client.resumeSession(sessionId, {
        clientName: "even-terminal",
        streaming: false,
        includeSubAgentStreamingEvents: false,
    });
    try {
        return mapCopilotHistory(await session.getEvents(), limit);
    }
    finally {
        await session.disconnect();
    }
}
