import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSessionInfo, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { summarizeClaudeToolCall } from "./summarize.js";
import { ClaudeSession } from "./session.js";
/** Find the jsonl file for a Claude session by scanning project dirs. */
export function findSessionFile(sessionId) {
    const claudeDir = join(homedir(), ".claude", "projects");
    if (!existsSync(claudeDir))
        return null;
    for (const dir of readdirSync(claudeDir)) {
        const p = join(claudeDir, dir, `${sessionId}.jsonl`);
        if (existsSync(p))
            return p;
    }
    return null;
}
// ── SDK message → display turn helpers ────────────────
function extractTextContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b.type === "text" && b.text?.trim())
            .map((b) => b.text)
            .join("\n");
    }
    return "";
}
function sdkBlockToLine(block) {
    if (block.type === "text" && block.text?.trim())
        return block.text;
    if (block.type === "tool_use")
        return "> " + summarizeClaudeToolCall(block.name, block.input ?? {});
    if (block.type === "tool_result")
        return extractTextContent(block.content) || null;
    return null;
}
export function createClaudeSdkProvider(emit, provider, loadSessionInfo = getSessionInfo) {
    const sessions = new Map();
    const loadingSessions = new Map();
    function makeSession(sessionId) {
        if (sessionId) {
            const existing = sessions.get(sessionId);
            if (existing)
                return existing;
        }
        const session = new ClaudeSession(emit, provider);
        session.onIdReady((sid) => {
            if (!sessions.has(sid))
                sessions.set(sid, session);
        });
        if (sessionId)
            sessions.set(sessionId, session);
        return session;
    }
    async function prompt(sessionId, text, cwd) {
        let session;
        if (sessionId) {
            let loading = loadingSessions.get(sessionId);
            if (!loading && !sessions.has(sessionId)) {
                loading = (async () => {
                    const info = await loadSessionInfo(sessionId);
                    if (!info && !findSessionFile(sessionId)) {
                        throw Object.assign(new Error(`Claude session not found: ${sessionId}`), { statusCode: 404 });
                    }
                    const created = makeSession(sessionId);
                    await created.start(sessionId, info?.cwd ?? cwd);
                    return created;
                })();
                loadingSessions.set(sessionId, loading);
            }
            if (loading) {
                try {
                    session = await loading;
                }
                finally {
                    if (loadingSessions.get(sessionId) === loading)
                        loadingSessions.delete(sessionId);
                }
            }
            else {
                session = sessions.get(sessionId);
            }
        }
        if (!session) {
            session = makeSession(sessionId);
            await session.start(sessionId, cwd);
        }
        // Emit user_prompt when session ID is known
        session.onIdReady((sid) => {
            emit(sid, { type: "user_prompt", text });
        });
        if (session.busy) {
            session.enqueue(text);
        }
        else {
            session.run(text).catch((err) => {
                console.error(`[claude-provider] run failed: ${err.message}`);
            });
        }
        const resolvedId = session.id ?? await session.waitForId(10000).catch(() => null) ?? "";
        return { sessionId: resolvedId, provider };
    }
    function respondPermission(sessionId, decision) {
        return sessions.get(sessionId)?.respondPermission(decision) ?? false;
    }
    function respondQuestion(sessionId, answer) {
        return sessions.get(sessionId)?.respondQuestion(answer) ?? false;
    }
    function interrupt(sessionId) {
        sessions.get(sessionId)?.interrupt();
    }
    function getStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (!session)
            return null;
        return { state: session.status, provider };
    }
    async function getSessionStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (session)
            return session.status;
        return "idle";
    }
    async function listClaudeSessions(limit, cwd) {
        const infos = await listSessions(cwd ? { dir: cwd, limit } : { limit });
        return infos.map((info) => ({
            id: info.sessionId,
            title: (info.customTitle || info.summary || info.firstPrompt || "").slice(0, 64),
            timestamp: new Date(info.lastModified).toISOString(),
            cwd: info.cwd || "",
            provider,
            status: null,
        }));
    }
    async function getInfo() {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        let version = "";
        try {
            const { stdout } = await execAsync("claude --version", { timeout: 3000 });
            version = stdout.trim().replace(" (Claude Code)", "");
        }
        catch { }
        let account = {};
        let model = "";
        try {
            const recent = await listSessions({ limit: 3 });
            for (const info of recent) {
                const messages = await getSessionMessages(info.sessionId);
                for (let i = messages.length - 1; i >= 0; i--) {
                    const entry = messages[i];
                    if (entry.type !== "assistant")
                        continue;
                    const m = entry.message?.model;
                    if (m) {
                        model = m;
                        break;
                    }
                }
                if (model)
                    break;
            }
        }
        catch { }
        let modelDisplay = "";
        if (model) {
            const parts = model.replace("claude-", "").replace(/-\d{8,}$/, "").split("-");
            const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            const ver = parts.slice(1).join(".");
            modelDisplay = name + (ver ? " " + ver : "");
        }
        try {
            const { stdout } = await execAsync("claude auth status", { timeout: 5000 });
            const auth = JSON.parse(stdout.trim());
            account = {
                email: auth.email ?? "",
                organization: auth.orgName ?? "",
                subscriptionType: auth.subscriptionType ?? "",
            };
        }
        catch { }
        return {
            account,
            model: modelDisplay || "Unknown",
            version: version || "Unknown",
            provider,
        };
    }
    const MAX_HISTORY_ITEMS = 10;
    async function getHistory(sessionId, limit) {
        const messages = await getSessionMessages(sessionId);
        let reduced = messages.reduce(function (acc, msg) {
            const contents = msg.message?.content;
            // User prompts are stored as a plain string; assistant turns (and some
            // user records) are an array of content blocks. Handle both.
            if (typeof contents === "string") {
                if (contents)
                    acc.push({ role: msg.type, text: contents });
            }
            else if (Array.isArray(contents)) {
                for (const content of contents) {
                    if (content?.type === "text") {
                        acc.push({ role: msg.type, text: content.text });
                    }
                }
            }
            return acc;
        }, []);
        let returnCount = Math.min(limit, MAX_HISTORY_ITEMS);
        return reduced.slice(-returnCount);
    }
    return {
        listSessions: listClaudeSessions,
        getSessionStatus,
        getInfo,
        getHistory,
        prompt,
        respondPermission,
        respondQuestion,
        interrupt,
        getStatus,
        isBusy: (sessionId) => loadingSessions.has(sessionId) || (sessions.get(sessionId)?.busy ?? false),
    };
}
export function createClaudeProvider(emit) {
    return createClaudeSdkProvider(emit, "claude");
}
