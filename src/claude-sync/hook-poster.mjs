#!/usr/bin/env node
// Sidecar invoked by claude's hook command. Reads the hook input JSON from
// stdin, POSTs it to the even-terminal server's hook endpoint, and pipes
// the server's response body to stdout — claude reads hook output from
// stdout, so a JSON body like
// `{"hookSpecificOutput":{"permissionDecision":"allow"}}` lets the server
// drive permission decisions through the hook protocol.
//
// Most hook events (PostToolUse, Notification, UserPromptSubmit) return an
// empty body; only PreToolUse / PermissionRequest for gated tools block.
//
// Env (injected by wrapper.mjs):
//   EVEN_TERMINAL_HOOK_URL — http://127.0.0.1:<port>/api/claude-sync/hook
//   EVEN_TERMINAL_WRAPPER_ID — identifies the persistent
//       WebSocket that the server binds to this hook's claude session id.
//
// Argv:
//   $1 — event kind (UserPromptSubmit | PreToolUse | PostToolUse | Notification | ...)

import http from "node:http";
import { URL } from "node:url";

const eventKind = process.argv[2];
const targetUrl = process.env.EVEN_TERMINAL_HOOK_URL;
const wrapperId = process.env.EVEN_TERMINAL_WRAPPER_ID;

// PreToolUse and PermissionRequest can both block on a user response from
// the app/glasses — give them a generous timeout. Everything else is
// fire-and-forget on the server side.
const BLOCKING_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);
const TIMEOUT_MS = BLOCKING_EVENTS.has(eventKind) ? 120_000 : 5_000;
const fail = () => process.exit(eventKind === "PreToolUse" && !wrapperId ? 2 : 0);

if (!eventKind) process.exit(0);
if (!targetUrl) fail();

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buf += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(buf || "{}"); } catch { payload = { _raw: buf }; }

  const body = JSON.stringify({ event: eventKind, payload, ...(wrapperId ? { wrapperId } : {}) });

  let url;
  try { url = new URL(targetUrl); } catch { fail(); return; }

  const req = http.request({
    method: "POST",
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname || "/",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: TIMEOUT_MS,
  }, (res) => {
    let respBuf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => { respBuf += c; });
    res.on("end", () => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300 || (BLOCKING_EVENTS.has(eventKind) && !respBuf.trim())) {
        fail();
        return;
      }
      if (respBuf) process.stdout.write(respBuf);
      process.exit(0);
    });
    res.on("aborted", fail);
  });

  req.on("error", fail);
  req.on("timeout", () => { try { req.destroy(); } catch {} fail(); });
  req.write(body);
  req.end();
});
