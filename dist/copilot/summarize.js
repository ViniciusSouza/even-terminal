import { oneLine, truncate } from "../summary-format.js";
function json(value) {
    try {
        return JSON.stringify(value) ?? "";
    }
    catch {
        return String(value ?? "");
    }
}
function boundedText(value, max = 4000) {
    const text = String(value ?? "");
    return text.length > max
        ? `${text.slice(0, max)}... [truncated]`
        : text;
}
export function summarizeCopilotTool(data) {
    const args = data.arguments;
    if (data.toolName === "shell" && args && typeof args === "object") {
        const command = "command" in args ? String(args.command ?? "") : "";
        if (command) {
            return `Shell ${truncate(command, 60)}`;
        }
    }
    return data.toolDescription?.name
        || data.mcpToolName
        || data.toolName
        || "Tool";
}
export function summarizeCopilotToolResult(data) {
    if (data.error?.message) {
        return boundedText(data.error.message);
    }
    return boundedText(data.result?.content
        || (data.success ? "Completed" : "Failed"));
}
export function describeCopilotPermission(request) {
    switch (request.kind) {
        case "shell":
            return {
                toolName: "Shell",
                description: request.intention || "Run shell command",
                detail: request.fullCommandText,
            };
        case "write":
            return {
                toolName: "FileEdit",
                description: request.intention || `Write ${request.fileName}`,
                detail: request.diff || request.newFileContents || request.fileName,
            };
        case "read":
            return {
                toolName: "FileRead",
                description: request.intention || `Read ${request.path}`,
                detail: request.path,
            };
        case "url":
            return {
                toolName: "WebFetch",
                description: request.intention || `Access ${request.url}`,
                detail: request.url,
            };
        case "mcp":
            return {
                toolName: request.toolTitle || request.toolName || "MCP",
                description: `Use ${request.serverName} tool ${request.toolName}`,
                detail: json(request.args),
            };
        case "custom-tool":
            return {
                toolName: request.toolName,
                description: request.toolDescription || `Use ${request.toolName}`,
                detail: json(request.args),
            };
        case "memory":
            return {
                toolName: "Memory",
                description: request.reason || "Update Copilot memory",
                detail: request.fact,
            };
        default:
            return {
                toolName: request.kind,
                description: `Approve ${request.kind} operation`,
                detail: json(request),
            };
    }
}
export function compactDetail(value, max = 4000) {
    return truncate(oneLine(value), max);
}
