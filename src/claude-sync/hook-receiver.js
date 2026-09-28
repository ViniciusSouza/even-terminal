import { summarizeClaudeToolCall } from "../claude/summarize.js";
import { detailFromInput, mapTodoWrite, normalizeQuestions, } from "../claude/mappers.js";
export function handleHookRequest(req, res, emit, transport) {
    const remote = req.socket.remoteAddress ?? "";
    const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLocal) {
        res.status(403).end();
        return;
    }
    const parsed = req.body ?? {};
    const event = String(parsed.event ?? "");
    const payload = parsed.payload ?? {};
    const sessionId = String(payload.session_id ?? "");
    const wrapperId = typeof parsed.wrapperId === "string" ? parsed.wrapperId : "";
    if (!event || !sessionId || !wrapperId) {
        res.status(400).end();
        return;
    }
    const session = transport.bindWrapped(wrapperId, sessionId);
    if (!session) {
        res.status(409).end();
        return;
    }
    handleWrapped(event, payload, session, emit, res);
}
// ── Wrapped: drive the phase machine ──────────────────────────────────
function handleWrapped(event, payload, session, emit, res) {
    const sessionId = String(payload.session_id ?? "");
    switch (event) {
        case "UserPromptSubmit": {
            const text = typeof payload.prompt === "string" ? payload.prompt : "";
            if (text)
                emit(sessionId, { type: "user_prompt", text });
            session.beginTurn();
            return res.status(204).end();
        }
        case "PreToolUse": {
            const name = String(payload.tool_name ?? "");
            const id = String(payload.tool_use_id ?? "");
            const input = (payload.tool_input ?? {});
            session.beforeTool(id); // resolve a stale prompt, note id, flush text
            if (name === "TodoWrite") {
                for (const m of mapTodoWrite(input))
                    emit(sessionId, m);
                return res.status(200).json({});
            }
            if (name === "AskUserQuestion") {
                // Pre-grant so claude shows its native widget (and PermissionRequest
                // for it stays silent — see below). The app/TUI then answer it.
                session.requestQuestion(normalizeQuestions(input), id);
                return res.status(200).json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
            }
            // Normal tool: tool_start/tool_end come from the transcript; perms go
            // through the PermissionRequest hook. Nothing to return.
            return res.status(200).json({});
        }
        case "PermissionRequest": {
            const name = String(payload.tool_name ?? "");
            // AskUserQuestion's PermissionRequest fires in addition to its PreToolUse
            // (already pre-granted + user_question emitted) — stay silent so it
            // doesn't overlay a Yes/No dialog on the question UI.
            if (!name || name === "AskUserQuestion")
                return res.status(200).json({});
            const input = (payload.tool_input ?? {});
            // Buffer it; the permission_request event is emitted from the drain,
            // after this tool's tool_start, so it follows the narration text.
            session.requestPermission(buildPermissionInfo(name, input, payload.permission_suggestions));
            return res.status(200).json({});
        }
        case "PostToolUse":
            session.afterTool(String(payload.tool_use_id ?? ""), payload.tool_response);
            return res.status(204).end();
        case "Stop": {
            const last = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
            session.finish(last);
            return res.status(204).end();
        }
        case "Notification": {
            // Only while actually working — not while idle (would bounce the UI) or
            // while a permission/question already owns the attention UI.
            if (session.phase === "busy")
                emit(sessionId, mapNotification(payload));
            return res.status(204).end();
        }
        default:
            return res.status(204).end();
    }
}
/** Build the permission_request info from a (wrapped) PermissionRequest payload. */
function buildPermissionInfo(name, input, rawSuggestions) {
    const suggestions = Array.isArray(rawSuggestions) ? rawSuggestions : null;
    const hasAlways = (suggestions?.length ?? 0) > 0;
    const options = [{ text: "Yes", key: "allow" }];
    if (hasAlways)
        options.push({ text: "Yes, and don't ask again", key: "allowAlways" });
    options.push({ text: "No", key: "deny" });
    return {
        toolName: name,
        description: summarizeClaudeToolCall(name, input),
        detail: detailFromInput(input),
        options,
        suggestions,
    };
}
function mapNotification(p) {
    const title = typeof p.title === "string" && p.title ? p.title : "Notice";
    const message = typeof p.message === "string" ? p.message : "";
    return { type: "notification", title, message };
}
