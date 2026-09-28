#!/usr/bin/env node
// `even-terminal claude` wrapper.
//
// Runs the real `claude` CLI inside a pty so the local user keeps the full
// interactive TUI, while the even-terminal server can mirror and drive the
// same session from the app/glasses:
//
//   - claude's hooks (installed via --settings) POST every event
//     (UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification,
//     PermissionRequest) to the server, which maps them to the app's
//     BridgeMessage stream and can return permission decisions.
//   - a persistent WebSocket to the server carries register/unregister and
//     lets the server inject stdin (prompts, permission digits) and
//     interrupts back into the pty.
//
// Transcript writes arrive as completed blocks rather than token deltas, so
// wrapped text is chunked more coarsely than Agent SDK output.
//
// The wrapper-to-server channel is localhost-only and unauthenticated by
// design — pick the right server instance via EVEN_TERMINAL_PORT.
//
// Optional env:
//   EVEN_TERMINAL_PORT     (default 3456) — which local server to forward to
//   EVEN_TERMINAL_VERBOSE=1 — keep boot logging on stderr for the whole run

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, appendFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as pty from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_POSTER = join(__dirname, "hook-poster.mjs");
const SERVER_PORT = Number(process.env.EVEN_TERMINAL_PORT ?? 3456);
const HOOK_URL = `http://127.0.0.1:${SERVER_PORT}/api/claude-sync/hook`;
const WRAPPER_ID = randomUUID();

// Logging: once claude's TUI takes over the terminal, anything we write to
// stderr scribbles on its rendering. Route all post-spawn logging to a
// tmpdir file; up to that point stderr stays visible so boot status (WS
// connect, etc.) reaches the user.
//
// EVEN_TERMINAL_VERBOSE=1 forces stderr output for the whole run.
const LOG_PATH = join(tmpdir(), `even-terminal-claude-${process.pid}.log`);
let LOG_FD = null;
try { LOG_FD = openSync(LOG_PATH, "a"); } catch {}
const VERBOSE = process.env.EVEN_TERMINAL_VERBOSE === "1";
let ttyTaken = false;

function writeLogFile(line) {
  if (LOG_FD == null) return;
  try { appendFileSync(LOG_FD, line); } catch {}
}
function log(...args) {
  const line = `[even-terminal claude] ${args.join(" ")}\n`;
  writeLogFile(line);
  if (VERBOSE || !ttyTaken) process.stderr.write(line);
}

/**
 * Write a hooks settings JSON file claude can load via `--settings <path>`.
 * Each hook invokes hook-poster.mjs with the event kind on argv. Hook input
 * (a JSON blob) is piped to stdin by claude; the poster forwards it to our
 * HTTP endpoint. `--settings` is additive, so user/project hooks still fire.
 *
 * The temp file is best-effort deleted on exit.
 */
function writeHookSettingsFile() {
  // On Windows claude code shells hooks through Git Bash (/usr/bin/bash),
  // which eats `\\` outside single quotes — and claude's command parser
  // appears to strip single quotes before bash sees the line, so paths like
  // `C:\Program Files\nodejs\node.exe` get mangled. Fix: pre-normalize to
  // forward slashes (Node accepts them on Windows) and quote with double
  // quotes (survives both sh and bash).
  const sh = (s) => {
    const v = process.platform === "win32" ? s.replace(/\\/g, "/") : s;
    if (/^[A-Za-z0-9_\-./:]+$/.test(v)) return v;
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
  };
  const cmd = (kind) => `${sh(process.execPath)} ${sh(HOOK_POSTER)} ${kind}`;
  const settings = {
    hooks: {
      // SessionStart fires when claude initializes (new or resumed). Its
      // hook POST carries WRAPPER_ID, allowing the server to bind this
      // wrapper's persistent WebSocket to claude's canonical session id.
      SessionStart:      [{ hooks: [{ type: "command", command: cmd("SessionStart") }] }],
      UserPromptSubmit:  [{ hooks: [{ type: "command", command: cmd("UserPromptSubmit") }] }],
      PreToolUse:        [{ hooks: [{ type: "command", command: cmd("PreToolUse") }] }],
      PostToolUse:       [{ hooks: [{ type: "command", command: cmd("PostToolUse") }] }],
      Notification:      [{ hooks: [{ type: "command", command: cmd("Notification") }] }],
      // Stop signals the end of the user-prompt agent loop; the server's
      // hook handler flushes the final assistant text + a single aggregated
      // `result` + `idle` for the whole loop.
      Stop:              [{ hooks: [{ type: "command", command: cmd("Stop") }] }],
      // PermissionRequest fires when claude itself wants permission (TUI
      // mode). The blocking handler emits permission_request to the app,
      // waits, and returns a structured decision.
      PermissionRequest: [{ hooks: [{ type: "command", command: cmd("PermissionRequest") }] }],
    },
  };
  const file = join(tmpdir(), `even-terminal-claude-hooks-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(settings), "utf-8");
  return file;
}

/**
 * Resolve the absolute path to the `claude` binary using the user's login
 * shell, so PATH lookups behave like an interactive terminal. node-pty's
 * posix_spawnp uses the spawned process's env PATH, which can be sparse when
 * the wrapper is launched from a globally-installed package — bare
 * `pty.spawn("claude", ...)` then fails with a generic "posix_spawnp failed".
 *
 * On Windows we deliberately don't resolve a path here — npm publishes
 * `claude` as sibling shims and `where claude` returns the extension-less
 * bash shim first, which ConPTY's CreateProcess refuses (code 193). Instead
 * we let `cmd.exe /c claude` resolve PATHEXT — see the pty.spawn site.
 */
function resolveClaudeBinary() {
  if (process.platform === "win32") return "claude";
  const shell = process.env.SHELL || "sh";
  const probe = spawnSync(shell, ["-l", "-c", "command -v claude"], { encoding: "utf8" });
  const found = probe.stdout?.trim();
  if (found) return found;
  return "claude";
}

// ── WebSocket transport to even-terminal server ─────────
//
// connect() identifies the persistent socket with a wrapper-minted id. The
// first hook POST later pairs that id with claude's canonical session id.
class Transport {
  constructor(wrapperId) {
    this.wrapperId = wrapperId;
    this.ws = null;
    this.connected = false;
    this.queue = [];          // outgoing frames queued before WS open
    this.closed = false;
    this.everConnected = false;
    this.lastError = "";
    this.onUnexpectedClose = null;  // set by main() after spawning claude
    this.onServerMessage = null;    // set by main(): dispatch server → wrapper msgs
    this.sessionId = null;
    this.registered = false;
    this.helloResolve = null;
  }
  async connect() {
    const wsUrl = `ws://127.0.0.1:${SERVER_PORT}/api/claude-sync/ws`;
    log(`connecting WS → ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => { this.ws.off("error", onError); resolve(); };
      const onError = (err) => { this.ws.off("open", onOpen); reject(err); };
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
    });
    this.connected = true;
    this.everConnected = true;
    this.ws.on("close", () => {
      this.connected = false;
      this.registered = false;
      if (!this.closed && this.onUnexpectedClose) {
        try { this.onUnexpectedClose(); } catch {}
      }
    });
    this.ws.on("error", (err) => {
      if (err.message !== this.lastError) {
        log("WS error:", err.message);
        this.lastError = err.message;
      }
    });
    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === "hello_ack" && msg.wrapperId === this.wrapperId) {
        this.helloResolve?.();
        return;
      }
      if (msg?.type === "registered" && typeof msg.sessionId === "string") {
        const prev = this.sessionId;
        this.sessionId = msg.sessionId;
        this.registered = true;
        log(prev ? `session switched ${prev} → ${msg.sessionId}` : `session discovered: ${msg.sessionId}`);
        return;
      }
      if (this.onServerMessage && msg && typeof msg.type === "string") {
        try { this.onServerMessage(msg); } catch (e) { log("server message handler error:", e?.message); }
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloResolve = null;
        reject(new Error("server did not acknowledge wrapper WebSocket"));
      }, 5000);
      this.helloResolve = () => {
        clearTimeout(timer);
        this.helloResolve = null;
        resolve();
      };
      this.ws.send(JSON.stringify({ type: "hello", wrapperId: this.wrapperId, cwd: process.cwd() }));
    });
    while (this.queue.length) this.ws.send(JSON.stringify(this.queue.shift()));
  }
  send(msg) {
    if (this.closed) return;
    if (!this.connected) { this.queue.push(msg); return; }
    try { this.ws.send(JSON.stringify(msg)); } catch (e) {
      if (e?.message !== this.lastError) {
        log("WS send failed:", e?.message);
        this.lastError = e?.message ?? "";
      }
    }
  }
  close() {
    this.closed = true;
    if (this.connected) {
      if (this.sessionId) {
        try { this.send({ type: "unregister", sessionId: this.sessionId }); } catch {}
      }
      try { this.ws.close(); } catch {}
    }
  }
}

async function main() {
  const transport = new Transport(WRAPPER_ID);
  try { await transport.connect(); }
  catch (e) {
    log("could not register wrapper with server:", e?.message ?? e);
    process.exit(1);
  }

  // Spawn claude inside a pty: multiplex user-terminal stdin and any
  // server-injected `{type:"stdin"}` over the same input channel; mirror
  // pty output to the user's stdout so the TUI renders normally.
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Session-id is discovered, not injected — pass user args through as-is.
  // claude owns the session lifecycle: `--resume <id>`, `--resume` bare
  // (picker), `--continue`, `--session-id <id>`, no args (fresh), and even
  // `/resume` slash command mid-TUI all work without special-casing here.
  const userArgs = process.argv.slice(2);
  const hookSettingsFile = writeHookSettingsFile();
  const claudeArgs = ["--settings", hookSettingsFile, ...userArgs];
  const claudeBin = resolveClaudeBinary();
  log(`spawning ${claudeBin}`);
  log(`logs: ${LOG_PATH}`);

  // node-pty / ConPTY on Windows can't launch .cmd/.bat or extension-less
  // npm shims directly (CreateProcess only accepts a real .exe). Route the
  // launch through cmd.exe so it can resolve PATHEXT and find claude.cmd.
  const isWindows = process.platform === "win32";
  const ptyFile = isWindows ? (process.env.ComSpec || "cmd.exe") : claudeBin;
  const ptyArgs = isWindows ? ["/c", claudeBin, ...claudeArgs] : claudeArgs;

  const claude = pty.spawn(ptyFile, ptyArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      EVEN_TERMINAL_HOOK_URL: HOOK_URL,
      EVEN_TERMINAL_WRAPPER_ID: WRAPPER_ID,
    },
  });
  // From here on, claude owns the terminal. Stop writing to stderr unless
  // EVEN_TERMINAL_VERBOSE=1 — log() still captures everything to LOG_PATH.
  ttyTaken = true;

  // When the server rejects our registration (session in use), we need to
  // detach claude's output BEFORE restoring the screen and printing the
  // reason — otherwise claude's late TUI writes (it may still be drawing for
  // ~100ms after SIGTERM) re-enter alt screen and clobber our message.
  let suppressClaudeOutput = false;
  claude.onData((data) => { if (!suppressClaudeOutput) process.stdout.write(data); });

  const hasTTY = !!process.stdin.isTTY;
  if (hasTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  process.stdin.on("data", (data) => {
    // Bare Esc (0x1b) in raw mode is claude TUI's cancel key — but claude
    // doesn't fire any hook on it, so the app is unaware. Notify the server
    // so it can flush an "Interrupted by user" result. Escape sequences
    // (arrow keys etc.) arrive as `0x1b` + more bytes in the same chunk, so
    // a single-byte 0x1b is the standalone Esc keypress. Only meaningful
    // once session is known.
    if (data.length === 1 && data[0] === 0x1b && transport.sessionId) {
      try { transport.send({ type: "interrupt_notify", sessionId: transport.sessionId }); } catch {}
    }
    claude.write(data);
  });

  const onResize = () => {
    try { claude.resize(process.stdout.columns || cols, process.stdout.rows || rows); } catch {}
  };
  process.stdout.on("resize", onResize);

  // Server → wrapper messages.
  transport.onServerMessage = (msg) => {
    switch (msg.type) {
      case "stdin":
        if (typeof msg.text === "string") {
          try { claude.write(msg.text); } catch {}
        }
        break;
      case "interrupt":
        try {
          claude.write("\x03");
          if (transport.sessionId) {
            transport.send({ type: "interrupt_notify", sessionId: transport.sessionId });
          }
        } catch {}
        break;
      case "register_reject":
        // Server is refusing because another worker (the SDK backend or
        // another wrapper) currently owns this session id (strict-state
        // rule: one session id = one owner).
        //
        // Order matters:
        //   1. Suppress further claude output so it can't redraw the alt
        //      screen / overwrite our message after we restore.
        //   2. restoreStdin → leave alt screen, raw mode off, etc.
        //   3. Write the reason to stderr (now on main screen).
        //   4. Kill claude + schedule exit.
        log(`register rejected by server: ${msg.reason ?? "unknown"}`);
        suppressClaudeOutput = true;
        restoreStdin();
        process.stderr.write(`\nSession is in use elsewhere (${msg.reason ?? "in-use"}). Wait for it to finish, then retry.\n`);
        try { claude.kill("SIGTERM"); } catch {}
        setTimeout(() => process.exit(2), 200);
        break;
      default:
        // ignore unknown
    }
  };

  // Server vanished mid-session → exit claude (mirrors `codex`).
  transport.onUnexpectedClose = () => {
    log("even-terminal server connection lost — exiting claude");
    try { claude.kill("SIGTERM"); } catch {}
  };

  let restored = false;
  const restoreStdin = () => {
    if (restored) return;
    restored = true;
    if (hasTTY) {
      try { process.stdin.setRawMode(false); } catch {}
      // Belt-and-braces: claude's TUI enables alt screen, mouse tracking,
      // cursor hiding, etc. If it's killed before its own cleanup runs we'd
      // leave the user's terminal wedged. Emit the canonical "leave
      // everything off" sequence.
      try {
        process.stdout.write(
          "\x1b[?1049l" +  // leave alt screen
          "\x1b[?1000l" +  // mouse tracking off
          "\x1b[?1002l" +
          "\x1b[?1003l" +
          "\x1b[?1006l" +
          "\x1b[?2004l" +  // bracketed paste off
          "\x1b[?25h" +    // show cursor
          "\x1b[!p"        // soft terminal reset
        );
      } catch {}
    }
    // Terminal is restored — stderr is safe again.
    ttyTaken = false;
    process.stdin.pause();
  };
  // Belt-and-braces: never leave the terminal in raw mode if we crash.
  const fullCleanup = () => {
    restoreStdin();
    try { if (claude.pid && !claude.killed) claude.kill("SIGTERM"); } catch {}
    try { unlinkSync(hookSettingsFile); } catch {}
  };
  process.on("exit", fullCleanup);
  process.on("uncaughtException", (err) => { log("uncaught:", err?.message); fullCleanup(); process.exit(1); });

  const cleanup = (signal) => {
    try { claude.kill(signal); } catch {}
    transport.close();
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  claude.onExit(({ exitCode, signal }) => {
    restoreStdin();
    transport.close();
    setTimeout(() => process.exit(exitCode ?? (signal ? 128 : 0)), 50);
  });
}

main().catch((e) => { log("fatal:", e?.stack ?? e); process.exit(1); });
