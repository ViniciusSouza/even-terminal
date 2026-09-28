import { Router } from "express";
import { writeDebugLog } from "../logger.js";
import { redactTokenQueryParam } from "../http-log.js";
const router = Router();
// ── Per-session message ring buffer + SSE clients ────
const MAX_MESSAGES_PER_SESSION = 500;
const sessions = new Map();
function getSession(sessionId) {
    let s = sessions.get(sessionId);
    if (!s) {
        s = { messages: [], clients: new Set(), nextId: 1, activeTurnStartId: null };
        sessions.set(sessionId, s);
    }
    return s;
}
export function pushMessage(sessionId, msg) {
    const s = getSession(sessionId);
    const id = s.nextId++;
    s.messages.push({ id, msg });
    if (msg.type === "user_prompt" && s.activeTurnStartId === null)
        s.activeTurnStartId = id;
    if (msg.type === "status" && msg.state === "busy" && s.activeTurnStartId === null)
        s.activeTurnStartId = id;
    if (msg.type === "status" && msg.state === "idle")
        s.activeTurnStartId = null;
    // Keep the active turn intact so a mid-turn client can replay its user prompt.
    const retainFrom = Math.min(id - MAX_MESSAGES_PER_SESSION + 1, s.activeTurnStartId ?? Infinity);
    const removeCount = s.messages.findIndex((entry) => entry.id >= retainFrom);
    if (removeCount > 0)
        s.messages.splice(0, removeCount);
    return id;
}
export function getMessages(sessionId, after) {
    const s = sessions.get(sessionId);
    if (!s)
        return [];
    return s.messages
        .filter((m) => m.id > after)
        .map((m) => ({ id: m.id, ...m.msg }));
}
export function broadcast(sessionId, msg, id) {
    const s = sessions.get(sessionId);
    const data = JSON.stringify(msg);
    writeDebugLog(`[SSE-${sessionId}]: ${data}`);
    if (!s || s.clients.size === 0)
        return;
    let deadCount = 0;
    for (const res of s.clients) {
        try {
            res.write(`id: ${id}\ndata: ${data}\n\n`);
        }
        catch {
            s.clients.delete(res);
            deadCount++;
        }
    }
    if (deadCount > 0) {
        console.warn(`[sse] Removed ${deadCount} dead client(s) for session=${sessionId} (remaining: ${s.clients.size})`);
    }
}
export function clientCount() {
    let total = 0;
    for (const s of sessions.values())
        total += s.clients.size;
    return total;
}
export function sessionHasClients(sessionId) {
    const s = sessions.get(sessionId);
    return !!s && s.clients.size > 0;
}
router.get("/events", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId' query parameter" });
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
    const s = getSession(sessionId);
    if (req.query.needReplay === "true" && s.messages.length > 0) {
        // Replay buffered messages for this session
        for (const entry of s.messages) {
            res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
        }
    }
    s.clients.add(res);
    console.log(`[sse] Client connected request=${redactTokenQueryParam(req.originalUrl)} session=${sessionId} `
        + `(session clients: ${s.clients.size}, total: ${clientCount()})`);
    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
        try {
            res.write(":heartbeat\n\n");
        }
        catch {
            clearInterval(heartbeat);
            s.clients.delete(res);
        }
    }, 15000);
    req.on("close", () => {
        clearInterval(heartbeat);
        s.clients.delete(res);
        console.log(`[sse] Client disconnected (total: ${clientCount()})`);
    });
});
export default router;
