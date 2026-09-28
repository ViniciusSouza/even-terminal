import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import eventsRouter from "./routes/events.js";
import coreRouter, { claudeSyncTransport, emitBridgeMessage, INFO_AUTH_ERROR } from "./routes/core.js";
import { handleHookRequest } from "./claude-sync/hook-receiver.js";
import { CODEX_APP_SERVER_PORT, printServerBanner, resolveHost, stopCodexAppServer } from "./startup/common.js";
import { removeInstancePidfile, writeInstancePidfile } from "./startup/instance.js";
import { startExposeProvider } from "./expose/run.js";
import { installTimestampLogging } from "./logger.js";
import { redactTokenQueryParam } from "./http-log.js";
import { stopCopilotClient } from "./copilot/client.js";
// ── Config ─────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3456", 10);
const TOKEN = process.env.BRIDGE_TOKEN ?? randomBytes(16).toString("hex");
const HOST = resolveHost();
const BIND_ADDRESS = HOST.address || "127.0.0.1";
// ── App ────────────────────────────────────────────────
const app = express();
if (process.env.EVEN_ALLOW_CORS === "1")
    app.use(cors());
app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        console.log(`[${req.ip}] ${res.statusCode} ${req.method} ${redactTokenQueryParam(req.originalUrl)} ${durationMs.toFixed(1)}ms`);
    });
    next();
});
app.use(express.json({ limit: "10mb" }));
// ── claude-sync hook endpoint (loopback-only, unauthenticated) ─
// Registered BEFORE the auth middleware: claude's spawned hooks don't have
// the bridge token, and they only reach us over localhost anyway.
app.post("/api/claude-sync/hook", (req, res) => {
    handleHookRequest(req, res, emitBridgeMessage, claudeSyncTransport);
});
// ── Auth middleware ────────────────────────────────────
function auth(req, res, next) {
    const header = req.headers.authorization;
    const queryToken = req.query.token;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
    if (provided !== TOKEN) {
        console.warn(`[auth] 401 ${req.method} ${redactTokenQueryParam(req.originalUrl)} (ip=${req.ip})`);
        res.status(401).json(INFO_AUTH_ERROR);
        return;
    }
    next();
}
// ── Routes ─────────────────────────────────────────────
app.use("/api", auth, eventsRouter);
app.use("/api", auth, coreRouter);
// ── HTTP server + claude-sync WebSocket transport ──────
const httpServer = createServer(app);
claudeSyncTransport.attach(httpServer);
const loopbackServer = BIND_ADDRESS === "127.0.0.1"
    ? null
    : createServer(app);
if (loopbackServer) {
    claudeSyncTransport.attach(loopbackServer);
    loopbackServer.on("error", (err) => {
        console.error(`[server] ERROR: failed to listen on loopback port ${PORT}: ${err.message}`);
        process.exit(1);
    });
}
// ── Start ──────────────────────────────────────────────
httpServer.listen(PORT, BIND_ADDRESS, () => {
    loopbackServer?.listen(PORT, "127.0.0.1");
    printServerBanner(PORT, TOKEN, process.env.PROJECT_DIR || process.cwd(), true, HOST, true);
    // codex app-server is lazy-spawned on first codex API call; see
    // ensureCodexAppServerStarted in startup/common.ts. `even-terminal codex`
    // discovers this process via the pidfile written here and pokes
    // POST /api/codex/ensure-app-server to wake the app-server before
    // attaching its `codex --remote` session.
    try {
        writeInstancePidfile({
            port: PORT,
            token: TOKEN,
            cwd: process.env.PROJECT_DIR || process.cwd(),
            codexAppServerPort: CODEX_APP_SERVER_PORT,
        });
    }
    catch (err) {
        console.error(`[server] WARN: failed to write instance pidfile: ${err?.message}`);
    }
    startExposeProvider(PORT, TOKEN);
    installTimestampLogging();
    const configuredClaudeTools = process.env.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS;
    if (configuredClaudeTools !== undefined) {
        const allowedTools = JSON.parse(configuredClaudeTools);
        console.log(`[claude] Effective auto-approved tools: ${allowedTools.join(", ") || "(none)"}`);
    }
});
// ── Process-level error handlers ──────────────────────
process.on("uncaughtException", (err) => {
    console.error(`[server] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
    console.error(`[server] UNHANDLED REJECTION: ${reason}`);
});
function cleanupSync() {
    stopCodexAppServer();
    removeInstancePidfile();
}
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    cleanupSync();
    try {
        const errors = await stopCopilotClient();
        for (const err of errors) {
            console.error(`[copilot] Failed to stop client: ${err.message}`);
        }
    }
    catch (err) {
        console.error(`[copilot] Failed to stop client: ${err.message}`);
    }
    process.exit(signal === "SIGINT" ? 130 : 0);
}
process.on("exit", cleanupSync);
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
