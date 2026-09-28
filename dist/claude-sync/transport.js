import { WebSocketServer } from "ws";
import { WrappedSession } from "./wrapped-session.js";
export class ClaudeSyncTransport {
    emit;
    wss;
    wrappers = new Map(); // wrapperId → persistent ws
    connections = new Map(); // sessionId → ws
    sessions = new Map(); // sessionId → phase machine
    /** Set by the provider during wiring. True while the SDK owns this session
     * id, preventing concurrent writers to the same transcript. */
    isSessionInUseElsewhere = null;
    constructor(emit) {
        this.emit = emit;
        this.wss = new WebSocketServer({ noServer: true });
    }
    setBusyCheck(fn) {
        this.isSessionInUseElsewhere = fn;
    }
    /** Attach to an existing http.Server; handle `upgrade` for our path only. */
    attach(server) {
        server.on("upgrade", (req, socket, head) => {
            const url = req.url ?? "";
            if (!url.startsWith("/api/claude-sync/ws")) {
                socket.destroy();
                return;
            }
            const remote = req.socket.remoteAddress ?? "";
            const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
            if (!isLocal) {
                console.warn(`[claude-sync] rejected non-local ws upgrade from ${remote}`);
                socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
        });
    }
    // ── lookups used by hook-receiver / provider ───────────────────────
    has(sessionId) {
        return this.connections.has(sessionId);
    }
    /** The phase machine for a registered wrapper, if present. */
    wrapped(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Bind a wrapper's persistent socket to the canonical session id carried
     *  by its hook POST. Repeated hooks are idempotent; a new id switches the
     *  same wrapper (for example TUI `/resume`) before that hook is routed. */
    bindWrapped(wrapperId, sessionId) {
        const wrapper = this.wrappers.get(wrapperId);
        if (!wrapper)
            return null;
        if (wrapper.sessionId === sessionId)
            return this.sessions.get(sessionId) ?? null;
        if (this.isSessionInUseElsewhere?.(sessionId)) {
            console.log(`[claude-sync] register REJECT sessionId=${sessionId} (SDK turn in progress)`);
            this.reject(wrapper.ws, "sdk-turn-in-progress");
            return null;
        }
        const existing = this.connections.get(sessionId);
        if (existing && existing !== wrapper.ws) {
            console.log(`[claude-sync] register REJECT sessionId=${sessionId} (another wrapper attached)`);
            this.reject(wrapper.ws, "another-wrapper-attached");
            return null;
        }
        if (wrapper.sessionId && this.connections.get(wrapper.sessionId) === wrapper.ws) {
            const previous = wrapper.sessionId;
            this.drop(previous);
            console.log(`[claude-sync] unregister(switched) sessionId=${previous}`);
        }
        wrapper.sessionId = sessionId;
        this.connections.set(sessionId, wrapper.ws);
        const session = new WrappedSession(sessionId, this.emit, (text) => { this.sendStdin(sessionId, text); });
        this.sessions.set(sessionId, session);
        try {
            wrapper.ws.send(JSON.stringify({ type: "registered", sessionId }));
        }
        catch { }
        console.log(`[claude-sync] register sessionId=${sessionId} cwd=${wrapper.cwd || "?"}`);
        return session;
    }
    sendStdin(sessionId, text) {
        return this.dispatch(sessionId, { type: "stdin", text });
    }
    sendInterrupt(sessionId) {
        return this.dispatch(sessionId, { type: "interrupt" });
    }
    // ── app answers for wrapped sessions ─────────────────────────────
    respondPermission(sessionId, decision) {
        const s = this.sessions.get(sessionId);
        if (s)
            return s.answerPermission(decision);
        return false;
    }
    respondQuestion(sessionId, answer) {
        const s = this.sessions.get(sessionId);
        if (s)
            return s.answerQuestion(answer);
        return false;
    }
    // ── WS connection lifecycle ────────────────────────────────────────
    onConnection(ws, req) {
        let connectedWrapperId = null;
        console.log(`[claude-sync] wrapper connected from ${req.socket.remoteAddress}`);
        ws.on("message", (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            if (!msg || typeof msg.type !== "string")
                return;
            switch (msg.type) {
                case "hello": {
                    const wrapperId = String(msg.wrapperId ?? "");
                    if (!wrapperId || connectedWrapperId)
                        return;
                    const existing = this.wrappers.get(wrapperId);
                    if (existing && existing.ws !== ws) {
                        this.reject(ws, "wrapper-id-in-use");
                        return;
                    }
                    connectedWrapperId = wrapperId;
                    this.wrappers.set(wrapperId, {
                        ws,
                        cwd: typeof msg.cwd === "string" ? msg.cwd : "",
                        sessionId: null,
                    });
                    try {
                        ws.send(JSON.stringify({ type: "hello_ack", wrapperId }));
                    }
                    catch { }
                    break;
                }
                case "unregister": {
                    const wrapper = connectedWrapperId ? this.wrappers.get(connectedWrapperId) : undefined;
                    const sid = String(msg.sessionId ?? wrapper?.sessionId ?? "");
                    if (sid && this.connections.get(sid) === ws) {
                        this.drop(sid);
                        if (wrapper?.sessionId === sid)
                            wrapper.sessionId = null;
                    }
                    break;
                }
                case "interrupt_notify": {
                    // The wrapper interrupted the TUI; claude fires no reliable hook, so the
                    // app would be unaware. Synthesize a result+idle so it clears.
                    const wrapper = connectedWrapperId ? this.wrappers.get(connectedWrapperId) : undefined;
                    const sid = String(msg.sessionId ?? wrapper?.sessionId ?? "");
                    this.sessions.get(sid)?.interrupt();
                    break;
                }
                default:
                    break;
            }
        });
        ws.on("close", () => {
            const wrapper = connectedWrapperId ? this.wrappers.get(connectedWrapperId) : undefined;
            if (wrapper?.ws === ws) {
                if (wrapper.sessionId && this.connections.get(wrapper.sessionId) === ws) {
                    console.log(`[claude-sync] wrapper disconnected sessionId=${wrapper.sessionId}`);
                    this.drop(wrapper.sessionId);
                }
                else {
                    console.log("[claude-sync] wrapper disconnected (unregistered)");
                }
                this.wrappers.delete(connectedWrapperId);
            }
        });
        ws.on("error", (err) => console.error(`[claude-sync] ws error: ${err.message}`));
    }
    /** Tear down a session: flush its phase machine to idle and forget it. */
    drop(sessionId) {
        this.sessions.get(sessionId)?.dispose();
        this.sessions.delete(sessionId);
        this.connections.delete(sessionId);
    }
    reject(ws, reason) {
        try {
            ws.send(JSON.stringify({ type: "register_reject", reason }));
        }
        catch { }
        try {
            ws.close();
        }
        catch { }
    }
    dispatch(sessionId, msg) {
        const ws = this.connections.get(sessionId);
        if (!ws)
            return false;
        try {
            ws.send(JSON.stringify(msg));
            return true;
        }
        catch {
            return false;
        }
    }
}
