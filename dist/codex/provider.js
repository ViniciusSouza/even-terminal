import { listCodexSessions, getCodexSessionHistory } from "./storage.js";
import { CodexSession } from "./session.js";
import { sessionHasClients } from "../routes/events.js";
import { codexThreadStatus } from "./status.js";
export { codexThreadStatus } from "./status.js";
export function createCodexProvider(emit, getClient) {
    const sessions = new Map();
    const promptQueues = new Map();
    const client = getClient();
    // ── Subscription state ─────────────────────────────────
    // subscribed: resume succeeded, notifications flow
    // pending:    an active thread's resume failed and will retry with backoff
    const subscribed = new Set();
    const pending = new Set();
    const subscribing = new Set();
    const pendingRetryCounts = new Map();
    const pendingRetryTimers = new Map();
    const activeThreads = new Set();
    const ignoredThreads = new Set();
    const bufferedEvents = new Map();
    const idleSince = new Map();
    const IDLE_TTL_MS = 3 * 60 * 1000;
    const MAX_SUBSCRIBE_FAILURES = 10;
    const SUBSCRIBE_RETRY_DELAYS_MS = [100, 250, 500, 1_000];
    function isSessionNotFoundError(err) {
        const anyErr = err;
        return anyErr?.rpcCode === -32004 || /(?:thread|session).*(?:not found|missing|unknown|not loaded)|not found.*(?:thread|session)/i.test(anyErr?.message ?? "");
    }
    function sessionNotFound(sessionId) {
        return Object.assign(new Error(`Codex session not found: ${sessionId}`), { statusCode: 404 });
    }
    function markSubscribed(threadId) {
        pending.delete(threadId);
        pendingRetryCounts.delete(threadId);
        subscribed.add(threadId);
    }
    function subscribe(threadId) {
        if (subscribed.has(threadId) || subscribing.has(threadId))
            return;
        const timer = pendingRetryTimers.get(threadId);
        if (timer) {
            clearTimeout(timer);
            pendingRetryTimers.delete(threadId);
        }
        subscribing.add(threadId);
        const session = sessions.get(threadId);
        const events = [];
        bufferedEvents.set(threadId, events);
        client.threadResumeSnapshot(threadId, () => {
            // The snapshot covers earlier events; pending requests are replayed after its response.
            events.length = 0;
        }).then((snapshot) => {
            if (sessions.get(threadId) !== session)
                return;
            session.restoreSnapshot(snapshot);
            bufferedEvents.delete(threadId);
            for (const event of events) {
                if (event.type === "notification")
                    session.handleNotification(event.method, event.params);
                else
                    session.handleServerRequest(event.requestId, event.method, event.params);
            }
            subscribing.delete(threadId);
            markSubscribed(threadId);
            if (!session.busy)
                dispatchNext(threadId);
            console.log(`[codex-provider] Subscribed to thread ${threadId}`);
        }).catch((err) => {
            if (sessions.get(threadId) !== session)
                return;
            subscribing.delete(threadId);
            subscribed.delete(threadId);
            const sawActivity = activeThreads.has(threadId) || pending.has(threadId) || events.some(event => event.type === "notification" && event.method === "thread/status/changed"
                && event.params?.status?.type === "active");
            if (!sawActivity && /no rollout found for thread id/i.test(err.message)) {
                bufferedEvents.delete(threadId);
                pending.delete(threadId);
                pendingRetryCounts.delete(threadId);
                console.log(`[codex-provider] Waiting for thread activity: ${threadId}`);
                if (!session.busy)
                    dispatchNext(threadId);
                return;
            }
            const failures = (pendingRetryCounts.get(threadId) ?? 0) + 1;
            pendingRetryCounts.set(threadId, failures);
            if (failures > MAX_SUBSCRIBE_FAILURES) {
                bufferedEvents.delete(threadId);
                pending.delete(threadId);
                pendingRetryCounts.delete(threadId);
                const queuedCount = promptQueues.get(threadId)?.length ?? 0;
                promptQueues.delete(threadId);
                if (queuedCount > 0) {
                    emit(threadId, {
                        type: "error",
                        message: `Codex subscription recovery failed after ${failures} attempts; ${queuedCount} queued prompts were not sent. Please retry.`,
                    });
                }
                console.log(`[codex-provider] Subscribe gave up for ${threadId} after ${failures} failures: ${err.message}`);
                return;
            }
            pending.add(threadId);
            const delay = SUBSCRIBE_RETRY_DELAYS_MS[Math.min(failures - 1, SUBSCRIBE_RETRY_DELAYS_MS.length - 1)];
            const retryTimer = setTimeout(() => {
                pendingRetryTimers.delete(threadId);
                if (pending.has(threadId))
                    subscribe(threadId);
            }, delay);
            pendingRetryTimers.set(threadId, retryTimer);
            console.log(`[codex-provider] Subscribe deferred for ${threadId}: ${err.message}; retry ${failures}/${MAX_SUBSCRIBE_FAILURES} in ${delay}ms`);
        });
    }
    function unsubscribe(threadId) {
        const timer = pendingRetryTimers.get(threadId);
        if (timer)
            clearTimeout(timer);
        client.threadUnsubscribe(threadId).catch(() => { });
        sessions.delete(threadId);
        subscribed.delete(threadId);
        pending.delete(threadId);
        subscribing.delete(threadId);
        bufferedEvents.delete(threadId);
        activeThreads.delete(threadId);
        pendingRetryCounts.delete(threadId);
        pendingRetryTimers.delete(threadId);
        idleSince.delete(threadId);
    }
    // Sweep: unsubscribe server-originated sessions idle >3min with no SSE clients
    setInterval(() => {
        const now = Date.now();
        for (const [threadId, since] of idleSince) {
            if (now - since < IDLE_TTL_MS)
                continue;
            if (sessionHasClients(threadId))
                continue;
            const session = sessions.get(threadId);
            if (session && session.status !== "idle")
                continue;
            console.log(`[codex-provider] Unsubscribing idle thread ${threadId} (${Math.round((now - since) / 1000)}s)`);
            unsubscribe(threadId);
        }
    }, 60_000).unref();
    // ── Prompt queue ───────────────────────────────────────
    function dispatchNext(sessionId) {
        const queue = promptQueues.get(sessionId);
        if (!queue || queue.length === 0)
            return;
        const next = queue.shift();
        if (queue.length === 0)
            promptQueues.delete(sessionId);
        const session = sessions.get(sessionId);
        if (!session)
            return;
        console.log(`[codex-provider] Dispatching queued prompt for session ${sessionId}`);
        session.run(next).catch((err) => {
            console.error(`[codex-provider] Failed to dispatch queued prompt: ${err.message}`);
        });
    }
    const wrappedEmit = (sessionId, msg) => {
        emit(sessionId, msg);
        if (msg.type === "status" && msg.state === "idle" && sessionId) {
            idleSince.set(sessionId, Date.now());
            if (!subscribing.has(sessionId))
                dispatchNext(sessionId);
        }
        else if (msg.type === "status" && msg.state === "busy" && sessionId) {
            idleSince.delete(sessionId);
        }
    };
    // ── Session factory ────────────────────────────────────
    function makeSession(sessionId) {
        if (sessionId) {
            const existing = sessions.get(sessionId);
            if (existing)
                return existing;
        }
        const session = new CodexSession(wrappedEmit, client);
        session.onIdReady((sid) => {
            if (!sessions.has(sid))
                sessions.set(sid, session);
            if (promptQueues.has("") && !promptQueues.has(sid)) {
                const queue = promptQueues.get("");
                promptQueues.delete("");
                if (queue.length > 0) {
                    promptQueues.set(sid, queue);
                    if (!session.busy)
                        dispatchNext(sid);
                }
            }
        });
        if (sessionId)
            sessions.set(sessionId, session);
        return session;
    }
    // ── Notification routing ───────────────────────────────
    function resolveThreadId(method, params) {
        const p = params ?? {};
        if (typeof p.threadId === "string" && p.threadId)
            return p.threadId;
        if (typeof p.thread?.id === "string" && p.thread.id)
            return p.thread.id;
        if (typeof p.turn?.threadId === "string" && p.turn.threadId)
            return p.turn.threadId;
        if (typeof p.item?.threadId === "string" && p.item.threadId)
            return p.item.threadId;
        if ((method === "error" || method === "turn/completed") && sessions.size === 1) {
            return [...sessions.keys()][0];
        }
        return undefined;
    }
    function resolveThreadCwd(params) {
        const p = params ?? {};
        if (typeof p.cwd === "string" && p.cwd)
            return p.cwd;
        if (typeof p.thread?.cwd === "string" && p.thread.cwd)
            return p.thread.cwd;
        if (typeof p.turn?.cwd === "string" && p.turn.cwd)
            return p.turn.cwd;
        if (typeof p.item?.cwd === "string" && p.item.cwd)
            return p.item.cwd;
        return undefined;
    }
    client.handleNotification = (method, params) => {
        const threadId = resolveThreadId(method, params);
        // No threadId — ignore account-level notifications silently, log others
        if (!threadId) {
            if (!method.startsWith("account/")) {
                console.error(`[codex-provider] notification missing threadId: method=${method}`);
            }
            return;
        }
        if (method === "thread/started" && params?.thread?.ephemeral === true
            && params.thread.threadSource === "system") {
            ignoredThreads.add(threadId);
            if (sessions.has(threadId))
                unsubscribe(threadId);
        }
        if (ignoredThreads.has(threadId)) {
            if (method === "thread/closed")
                ignoredThreads.delete(threadId);
            return;
        }
        // Thread closed — clean up immediately
        if (method === "thread/closed") {
            if (sessions.has(threadId)) {
                console.log(`[codex-provider] Thread ${threadId} closed, unsubscribing`);
                unsubscribe(threadId);
            }
            return;
        }
        if (method === "thread/status/changed") {
            if (params?.status?.type === "active") {
                if (!activeThreads.has(threadId))
                    pendingRetryCounts.delete(threadId);
                activeThreads.add(threadId);
            }
            else {
                activeThreads.delete(threadId);
            }
        }
        // Empty threads wait for activity; an active notification bypasses backoff.
        if (!sessions.has(threadId)) {
            console.log(`[codex-provider] Discovered thread ${threadId}`);
            const session = new CodexSession(wrappedEmit, client);
            session.start(threadId, resolveThreadCwd(params)).catch(() => { });
            sessions.set(threadId, session);
            subscribe(threadId);
        }
        else if (method === "thread/status/changed" && params?.status?.type === "active") {
            subscribe(threadId);
        }
        const events = bufferedEvents.get(threadId);
        if (events) {
            events.push({ type: "notification", method, params });
            return;
        }
        sessions.get(threadId).handleNotification(method, params);
    };
    client.handleServerRequest = (requestId, method, params) => {
        const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
        if (!threadId) {
            console.error(`[codex-provider] server request missing threadId: id=${String(requestId)} method=${method}`);
            return;
        }
        if (ignoredThreads.has(threadId))
            return;
        const events = bufferedEvents.get(threadId);
        if (events) {
            events.push({ type: "request", requestId, method, params });
            return;
        }
        sessions.get(threadId)?.handleServerRequest(requestId, method, params);
    };
    client.handleClose = (error) => {
        for (const session of sessions.values()) {
            session.handleClientClose(error);
        }
    };
    // ── API handlers ───────────────────────────────────────
    async function getSessionStatus(sessionId) {
        if (!subscribed.has(sessionId) && activeThreads.has(sessionId))
            return "busy";
        const session = sessions.get(sessionId);
        if (session)
            return session.status;
        try {
            const thread = await client.threadRead(sessionId, false);
            return codexThreadStatus(thread);
        }
        catch {
            return "idle";
        }
    }
    async function listSessions(limit, cwd) {
        const sessions = await listCodexSessions(client, limit, cwd);
        return sessions.map((s) => ({ ...s, provider: "codex", status: s.status ?? null }));
    }
    async function getInfo() {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        let version = "";
        try {
            const { stdout } = await execAsync("codex --version", { timeout: 3000 });
            version = stdout.trim();
        }
        catch { }
        let account = {};
        try {
            const acct = await client.getAccount();
            if (acct) {
                account = {
                    email: acct.email ?? "",
                    planType: acct.planType ?? "",
                    type: acct.type ?? "",
                };
            }
        }
        catch { }
        return {
            account,
            model: "Codex",
            version: version || "Unknown",
            provider: "codex",
        };
    }
    async function getHistory(sessionId, limit) {
        return getCodexSessionHistory(client, sessionId, limit);
    }
    async function prompt(sessionId, text, cwd) {
        let session;
        if (sessionId)
            session = sessions.get(sessionId);
        if (!session) {
            if (sessionId) {
                try {
                    const thread = await client.threadRead(sessionId, false);
                    if (!thread)
                        throw sessionNotFound(sessionId);
                }
                catch (err) {
                    if (err?.statusCode === 404 || isSessionNotFoundError(err))
                        throw sessionNotFound(sessionId);
                    throw err;
                }
            }
            session = makeSession(sessionId);
            await session.start(sessionId, cwd);
        }
        if (session.busy || (sessionId && (subscribing.has(sessionId) || pending.has(sessionId)
            || (!subscribed.has(sessionId) && activeThreads.has(sessionId))))) {
            const queueKey = session.id || sessionId || "";
            const queue = promptQueues.get(queueKey) || [];
            queue.push(text);
            promptQueues.set(queueKey, queue);
            console.log(`[codex-provider] Queued prompt for session ${queueKey} (queue size: ${queue.length})`);
        }
        else {
            try {
                await session.run(text);
                if (session.id)
                    markSubscribed(session.id);
            }
            catch (err) {
                if (sessionId && isSessionNotFoundError(err)) {
                    sessions.delete(sessionId);
                    throw sessionNotFound(sessionId);
                }
                throw err;
            }
        }
        const resolvedId = session.id ?? await session.waitForId(10000).catch(() => null) ?? "";
        return { sessionId: resolvedId, provider: "codex" };
    }
    function respondPermission(sessionId, decision) {
        sessions.get(sessionId)?.respondPermission(decision);
    }
    function respondQuestion(sessionId, answer) {
        sessions.get(sessionId)?.respondQuestion(answer);
    }
    function interrupt(sessionId) {
        sessions.get(sessionId)?.interrupt();
    }
    function getStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (!session)
            return null;
        const state = !subscribed.has(sessionId) && activeThreads.has(sessionId) ? "busy" : session.status;
        return { state, provider: "codex" };
    }
    function getSubscribedSessions() {
        const now = Date.now();
        const result = [];
        for (const [threadId, session] of sessions) {
            const idle = idleSince.get(threadId);
            result.push({
                threadId,
                status: session.status,
                idleSinceMs: idle != null ? now - idle : null,
            });
        }
        return result;
    }
    return {
        listSessions,
        getSessionStatus,
        getInfo,
        getHistory,
        prompt,
        respondPermission,
        respondQuestion,
        interrupt,
        getStatus,
        getSubscribedSessions,
    };
}
