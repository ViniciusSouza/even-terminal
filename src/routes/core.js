import { Router } from "express";
import { isProvider, resolveProviderName, SUPPORTED_PROVIDERS } from "../session.js";
import { broadcast, pushMessage, getMessages } from "./events.js";
import { createClaudeProvider } from "../claude/provider.js";
import { createClaudeSyncProvider } from "../claude-sync/provider.js";
import { USE_ORIGINAL_CLAUDE } from "../claude-sync/provider-name.js";
import { ClaudeSyncTransport } from "../claude-sync/transport.js";
import { createCodexProvider } from "../codex/provider.js";
import { createCopilotProvider } from "../copilot/provider.js";
import { createBuiltInIntegrationRegistry } from "../integrations/built-ins.js";
// cursor/opencode hidden in 0.8.1 (experimental) — re-enable alongside SUPPORTED_PROVIDERS.
// import { createCursorProvider } from "../cursor/provider.js";
// import { createOpencodeProvider } from "../opencode/provider.js";
import { CodexAppServerClient } from "../codex/app-server.js";
import { debugLog } from "../debug.js";
import { CODEX_APP_SERVER_PORT } from "../startup/common.js";
import { checkForUpdate, getCurrentAppVersion } from "../update.js";
const router = Router();
const emit = (sessionId, msg) => {
    if (!sessionId)
        return;
    const id = pushMessage(sessionId, msg);
    broadcast(sessionId, msg, id);
};
const STATUS_CHECK_COUNT = 10;
export const INFO_AUTH_ERROR = {
    error: { code: "auth_failed", message: "Unauthorized" },
};
function getExposeType() {
    const expose = process.env.EVEN_TERMINAL_EXPOSE_PROVIDER;
    if (expose === "pinggy" || expose === "bore" || expose === "ngrok")
        return expose;
    if (expose)
        return "other";
    if (process.env.EVEN_HOST_MODE === "tailscale")
        return "tailscale";
    return process.env.EVEN_HOST_MODE ? "other" : "off";
}
function toOneLineJson(value, maxLen = 1200) {
    try {
        const text = JSON.stringify(value);
        if (!text)
            return String(value);
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    }
    catch {
        return String(value);
    }
}
const codexClient = new CodexAppServerClient(`ws://127.0.0.1:${CODEX_APP_SERVER_PORT}`);
const claudeSyncTransport = new ClaudeSyncTransport(emit);
const claudeProvider = createClaudeProvider(emit);
const claudeSyncProvider = createClaudeSyncProvider(emit, claudeSyncTransport);
const codexProvider = createCodexProvider(emit, () => codexClient);
const copilotProvider = createCopilotProvider(emit);
// const cursorProvider = createCursorProvider(emit);
// const opencodeProvider = createOpencodeProvider(emit);
const providerRegistry = createBuiltInIntegrationRegistry({
    claude: claudeProvider,
    claudeSync: claudeSyncProvider,
    codex: codexProvider,
    copilot: copilotProvider,
    useOriginalClaude: USE_ORIGINAL_CLAUDE,
});
export { codexClient, claudeSyncTransport, emit as emitBridgeMessage };
export function getProvider(name) {
    return providerRegistry.get(resolveProviderName(name));
}
router.use((req, res, next) => {
    for (const provider of [req.query.provider, req.body?.provider]) {
        if (provider !== undefined && !isProvider(provider)) {
            res.status(400).json({ error: `Unsupported provider "${String(provider)}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}` });
            return;
        }
    }
    next();
});
// GET /api/sessions — list resumable sessions
router.get("/sessions", async (req, res) => {
    const providerName = req.query.provider;
    const resolvedProvider = resolveProviderName(providerName);
    const cwd = req.query.cwd;
    const provider = getProvider(resolvedProvider);
    const limit = Number(req.query.limit) || 10;
    try {
        const sessions = await provider.listSessions(limit, cwd);
        await Promise.all(sessions.slice(0, STATUS_CHECK_COUNT).map(async (s, i) => {
            if (s.status)
                return;
            sessions[i].status = await provider.getSessionStatus(s.id);
        }));
        res.json({ sessions });
    }
    catch (err) {
        res.json({ sessions: [], error: err.message });
    }
});
// GET /api/info — account, model, version, provider
router.get("/info", async (req, res) => {
    const providerName = req.query.provider;
    const provider = getProvider(providerName);
    try {
        const info = await provider.getInfo();
        res.json({ ...info, extra: { expose: getExposeType() } });
    }
    catch (err) {
        res.status(500).json({
            error: {
                code: "info_failed",
                message: err instanceof Error ? err.message : String(err),
            },
        });
    }
});
// GET /api/update-check — current app version and latest npm version
router.get("/update-check", async (_req, res) => {
    try {
        res.json(await checkForUpdate());
    }
    catch (err) {
        res.json({
            ...getCurrentAppVersion(),
            newestVersion: null,
            updateAvailable: null,
            error: err.message,
        });
    }
});
// POST /api/prompt — send a prompt to a session (create if needed)
router.post("/prompt", async (req, res) => {
    const { text, sessionId, provider, cwd } = req.body ?? {};
    console.log(`[prompt] sessionId=${sessionId ?? "(none)"} (provider=${provider}) text=${(text || "").slice(0, 80)}`);
    if (!text || typeof text !== "string") {
        console.warn("[prompt] rejected: missing text field");
        res.status(400).json({ error: "Missing 'text' field" });
        return;
    }
    try {
        const targetProvider = getProvider(provider);
        const effectiveCwd = sessionId ? undefined : cwd ?? process.env.PROJECT_DIR;
        const result = await targetProvider.prompt(sessionId, text, effectiveCwd);
        res.status(202).json({ ok: true, sessionId: result.sessionId, provider: result.provider });
    }
    catch (err) {
        console.error("[prompt] failed:", err.message);
        const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
        res.status(statusCode).json({ error: err.message });
    }
});
// POST /api/permission-response
router.post("/permission-response", (req, res) => {
    const { sessionId, decision, provider } = req.body ?? {};
    console.log(`[permission-response] sessionId=${sessionId ?? "(none)"} provider=${provider ?? "(default)"} decision=${decision ?? "deny"}`);
    debugLog("api", "permission-response body", toOneLineJson(req.body ?? {}));
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    const accepted = targetProvider.respondPermission(sessionId, decision || "deny");
    if (accepted === false) {
        res.status(400).json({ error: "Permission decision was not offered or no permission request is pending" });
        return;
    }
    res.json({ ok: true });
});
// POST /api/question-response
router.post("/question-response", (req, res) => {
    const { sessionId, answer, provider } = req.body ?? {};
    console.log(`[question-response] sessionId=${sessionId ?? "(none)"} provider=${provider ?? "(default)"} answer=${String(answer ?? "skip").slice(0, 120)}`);
    debugLog("api", "question-response body", toOneLineJson(req.body ?? {}));
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    const accepted = targetProvider.respondQuestion(sessionId, answer || "skip");
    if (accepted === false) {
        res.status(400).json({ error: "Question answer was not accepted or no question is pending" });
        return;
    }
    res.json({ ok: true });
});
// POST /api/interrupt
router.post("/interrupt", async (req, res) => {
    const { sessionId, provider } = req.body ?? {};
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const targetProvider = getProvider(provider);
    if (!targetProvider.getStatus(sessionId)) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    try {
        await targetProvider.interrupt(sessionId);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
// GET /api/status
router.get("/status", (req, res) => {
    const sessionId = req.query.sessionId;
    const providerName = req.query.provider;
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const status = getProvider(providerName).getStatus(sessionId);
    if (!status) {
        res.status(404).json({ error: "Session not found" });
        return;
    }
    res.json({
        state: status.state,
        sessionId,
        provider: status.provider,
    });
});
// GET /api/messages?sessionId=&after=
router.get("/messages", (req, res) => {
    const after = parseInt(req.query.after) || 0;
    const sessionId = req.query.sessionId;
    const providerName = resolveProviderName(req.query.provider);
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId'" });
        return;
    }
    const status = getProvider(providerName).getStatus(sessionId);
    const messages = getMessages(sessionId, after);
    res.json({
        messages,
        state: status?.state ?? "idle",
        sessionId,
        provider: status?.provider ?? providerName ?? null,
    });
});
// GET /api/debug/thread/:id — raw app-server / SDK output for debugging
router.get("/debug/thread/:id", async (req, res) => {
    const id = req.params.id;
    const provider = resolveProviderName(req.query.provider);
    try {
        if (provider === "codex") {
            const thread = await codexClient.threadRead(id, true);
            res.json(thread);
        }
        else if (provider === "claude") {
            const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
            const messages = await getSessionMessages(id);
            res.json({ sessionId: id, messages });
        }
        else {
            // ACP providers (cursor, opencode): no raw SDK dump — surface the
            // provider's reconstructed history so the debug view still has content.
            const history = await getProvider(provider).getHistory(id, 50);
            res.json({ sessionId: id, messages: history });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/debug/status/:id — test status detection against real data
router.get("/debug/status/:id", async (req, res) => {
    const id = req.params.id;
    const providerName = resolveProviderName(req.query.provider);
    const provider = getProvider(providerName);
    try {
        const status = await provider.getSessionStatus(id);
        res.json({ sessionId: id, provider: providerName, status });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// GET /api/sessions/:id/history
router.get("/sessions/:id/history", async (req, res) => {
    const id = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 10);
    const providerName = resolveProviderName(req.query.provider);
    const provider = getProvider(providerName);
    try {
        const history = await provider.getHistory(id, limit);
        res.json({ history });
    }
    catch (err) {
        res.json({ history: [], error: err.message });
    }
});
// GET /api/metrics — codex subscription state for monitoring
router.get("/metrics", (_req, res) => {
    const subscribed = codexProvider.getSubscribedSessions();
    res.json({ codex: { subscribedSessions: subscribed } });
});
// Initialize the bridge connection before the remote CLI can create its thread.
router.post("/codex/ensure-app-server", async (_req, res) => {
    try {
        await codexClient.connect();
        res.json({ started: true, port: CODEX_APP_SERVER_PORT });
    }
    catch (err) {
        res.status(500).json({ started: false, error: err?.message ?? String(err) });
    }
});
export default router;
