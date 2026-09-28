/**
 * Wrapped-session phase machine — the single owner of all state for one
 * `even-terminal claude` (wrapped) session.
 *
 * There is no programmatic output stream in wrapped mode, so we reconstruct
 * the session from two channels and keep ONE explicit phase in sync with the
 * glasses:
 *
 *   phase: idle | busy | awaiting_permission | awaiting_question
 *
 *   UserPromptSubmit            idle → busy            user_prompt, status:busy
 *   PermissionRequest           busy → awaiting_perm   (buffered — permission_request is
 *                                                       emitted from the drain after the
 *                                                       tool's tool_start, so it follows
 *                                                       the narration text)
 *   AskUserQuestion (PreTool)   busy → awaiting_quest  user_question
 *   tool_result (drain)         awaiting_perm → busy   permission_result (allowed/denied
 *                                                       read from the result; fires for
 *                                                       denials, which have no PostToolUse)
 *   PostToolUse (matching id)   awaiting_* → busy      permission_result / question_answer
 *   next PreToolUse / Stop       awaiting_* → busy/idle backstop: denied / skip
 *   Stop                        * → idle               result, status:idle
 *   interrupt / disconnect      * → idle               result(interrupted), status:idle
 *
 * Invariant: every transition emits its bridge event, so the glasses' view
 * always equals `phase`. Content (text + tool_start/tool_end) is drained from
 * the transcript in document order (a file watcher drives it); answers from
 * the glasses are injected into the native TUI widgets.
 */
import { readFileSync, watch } from "node:fs";
import { findSessionFile } from "../claude/provider.js";
import { summarizeClaudeToolCall } from "../claude/summarize.js";
import { extractQuestionAnswers } from "../claude/mappers.js";
import { PROVIDER_NAME } from "./provider-name.js";
/** Tools with dedicated hook-driven UIs — never emitted as generic tools. */
const CONTROL_TOOLS = new Set(["TodoWrite", "AskUserQuestion"]);
// Key-injection timing for the AskUserQuestion widget. A selection key must
// land after arrow navigation has settled — ≤150ms is ignored, ≥200ms
// works (verified). The next question's widget needs a beat to render.
const ENTER_DELAY_MS = 350;
const QUESTION_GAP_MS = 700;
// A fixed delay can't guarantee the widget settled, so re-send Enter until
// the answer registers (the question resolves via PostToolUse).
const ENTER_RETRY_MS = 1000;
const MAX_ENTER_RETRIES = 3;
// permission_request is normally emitted from the drain (after tool_start, so
// it follows the narration). But claude often writes nothing to the transcript
// while it waits for approval, so there's no tool_start to attach to — emit
// anyway after this grace so the glasses always see the prompt.
const PERMISSION_EMIT_GRACE_MS = 600;
export class WrappedSession {
    sessionId;
    emit;
    sendStdin;
    phase = "idle";
    startMs = 0;
    // transcript drain
    cursor = 0;
    watcher = null;
    pendingTools = new Map();
    lastText = "";
    // permission/question id borrowing + open prompts
    lastPreToolId = "";
    permission = null;
    question = null;
    // app prompts arriving mid-turn wait their turn (FIFO), never typed into a
    // busy TUI. `submitting` covers the gap between injecting and the turn
    // actually starting (UserPromptSubmit).
    promptQueue = [];
    submitting = false;
    constructor(sessionId, emit, sendStdin) {
        this.sessionId = sessionId;
        this.emit = emit;
        this.sendStdin = sendStdin;
    }
    /** Authoritative status for this session while its wrapper is live. */
    get status() {
        return this.phase === "busy" ? "busy" : this.phase === "idle" ? "idle" : "awaiting";
    }
    // ── lifecycle ──────────────────────────────────────────────────────
    /** UserPromptSubmit: start a turn. Hard-resets any stale prompt. */
    beginTurn() {
        this.resolveStale();
        this.stopWatch();
        this.phase = "busy";
        this.submitting = false; // the submitted prompt has landed
        this.startMs = Date.now();
        this.cursor = this.readLines().length; // skip prior turns
        this.pendingTools.clear();
        this.lastText = "";
        this.out({ type: "status", state: "busy", sessionId: this.sessionId, provider: PROVIDER_NAME });
        this.startWatch();
        this.drain();
    }
    /** Stop: drain remaining content, resolve any open prompt, emit result+idle. */
    finish(finalText) {
        if (this.phase === "idle")
            return;
        this.drain();
        this.resolveStale();
        if (finalText && finalText !== this.lastText)
            this.emitText(finalText);
        this.out(this.result(true, finalText));
        this.out({ type: "status", state: "idle", sessionId: this.sessionId, provider: PROVIDER_NAME });
        this.endTurn();
    }
    /** Esc / wrapper disconnect mid-turn. */
    interrupt() {
        if (this.phase === "idle")
            return;
        this.drain();
        this.resolveStale();
        this.out(this.result(false, "Interrupted by user"));
        this.out({ type: "status", state: "idle", sessionId: this.sessionId, provider: PROVIDER_NAME });
        this.endTurn();
    }
    /** Wrapper went away for good: clear the turn and stop watching. */
    dispose() {
        this.interrupt();
        this.stopWatch();
    }
    // ── prompt submission (app → TUI) ──────────────────────────────────
    /** Submit a prompt from the app. Injected immediately when idle; otherwise
     *  queued and dispatched FIFO as turns complete — never typed into a busy
     *  TUI or over an open permission/question prompt. */
    submitPrompt(text) {
        if (this.phase === "idle" && !this.submitting)
            this.injectPrompt(text);
        else
            this.promptQueue.push(text);
    }
    dispatchNext() {
        const next = this.promptQueue.shift();
        if (next !== undefined)
            this.injectPrompt(next);
    }
    injectPrompt(text) {
        this.submitting = true;
        // Bracketed paste (one literal block), then a SEPARATE delayed Enter — a
        // \r glued to the paste isn't submitted by claude 2.1.178.
        this.sendStdin("\x1b[200~" + text + "\x1b[201~");
        setTimeout(() => this.sendStdin("\r"), 200);
    }
    // ── tool boundaries ────────────────────────────────────────────────
    /** Runs before any tool. A new tool means an open prompt was answered: an
     *  allow/answer resolves via PostToolUse, so a survivor here was denied
     *  (permission) or skipped (question) in the TUI. */
    beforeTool(toolUseId) {
        this.resolvePermission("denied");
        this.resolveQuestion(null);
        this.lastPreToolId = toolUseId;
        this.drain();
    }
    /** PostToolUse. Permission is resolved by the drain (from the tool_result,
     *  in order after tool_start) — NOT here, or it would jump ahead of the
     *  tool_start the drain hasn't emitted yet. Questions are resolved here
     *  because the drain skips AskUserQuestion (a control tool). */
    afterTool(toolUseId, toolResponse) {
        if (this.question?.toolUseId === toolUseId)
            this.resolveQuestion(extractQuestionAnswers(toolResponse));
        this.drain();
    }
    // ── permission ─────────────────────────────────────────────────────
    /** PermissionRequest hook: buffer the prompt. The permission_request event
     *  is emitted later — from the drain, right after this tool's tool_start —
     *  so it follows the narration text in document order (the hook fires ahead
     *  of the transcript write, so emitting now would jump the queue). */
    requestPermission(info) {
        this.permission = { info, toolUseId: this.lastPreToolId, requested: false };
        this.phase = "awaiting_permission";
        // If this tool's tool_start already drained (the assistant record was on
        // disk before this hook fired), emit now — right after that tool_start.
        if (this.pendingTools.has(this.lastPreToolId)) {
            this.emitPermissionRequest();
            return;
        }
        // Otherwise prefer the drain (it emits this after the tool_start, keeping
        // it ordered after the narration). But claude may write nothing to the
        // transcript while it waits for approval, so fall back to a grace timer —
        // the glasses must see the prompt even if no tool_start ever drains.
        const p = this.permission;
        setTimeout(() => {
            if (this.permission === p && !p.requested)
                this.emitPermissionRequest();
        }, PERMISSION_EMIT_GRACE_MS);
    }
    /** Emit the deferred permission_request (idempotent). Called from the drain
     *  when the tool's tool_start is emitted, or from resolve as a fallback if
     *  it resolves before its tool_start ever drained. */
    emitPermissionRequest() {
        const p = this.permission;
        if (!p || p.requested)
            return;
        p.requested = true;
        this.out({
            type: "permission_request",
            toolName: p.info.toolName,
            description: p.info.description,
            detail: p.info.detail,
            toolUseId: p.toolUseId,
            options: p.info.options,
            suggestions: p.info.suggestions,
        });
    }
    /** App answered a permission: drive the TUI digit (the permission widget
     *  auto-confirms on a digit) and emit the result. First answer wins — a
     *  no-op if the TUI already resolved it. */
    answerPermission(decision) {
        const p = this.permission;
        if (!p)
            return false;
        const idx = p.info.options.findIndex((o) => o.key === decision);
        if (idx < 0)
            return false;
        this.sendStdin(String(idx + 1));
        this.resolvePermission(decision === "allowAlways" ? "always" : decision === "allow" ? "allowed" : "denied");
        return true;
    }
    resolvePermission(decision) {
        const p = this.permission;
        if (!p)
            return;
        if (!p.requested)
            this.emitPermissionRequest(); // ensure request precedes result
        this.permission = null;
        if (this.phase === "awaiting_permission")
            this.phase = "busy";
        this.out({ type: "permission_result", toolName: p.info.toolName, summary: p.info.description, decision });
    }
    // ── question ───────────────────────────────────────────────────────
    requestQuestion(questions, toolUseId) {
        this.question = { questions, toolUseId };
        this.phase = "awaiting_question";
        this.out({ type: "user_question", questions, toolUseId });
    }
    /** App answered a question: drive the native single- or multi-select widget.
     *  The question_answer event comes from
     *  the resulting PostToolUse (claude's recorded answer is authoritative),
     *  so we don't emit it here — symmetric with a TUI answer. */
    answerQuestion(answer) {
        const q = this.question;
        if (!q)
            return false;
        const selections = computeSelections(q.questions, answer);
        let at = 0;
        for (const [questionIndex, indexes] of selections.entries()) {
            const t = at;
            if (indexes.length === 0) {
                setTimeout(() => this.sendStdin("\x1b"), t); // Esc = skip this question
                at += QUESTION_GAP_MS;
            }
            else if (!q.questions[questionIndex].multiSelect) {
                const idx = indexes[0];
                if (idx > 0)
                    setTimeout(() => this.sendStdin("\x1b[B".repeat(idx)), t); // navigate down
                setTimeout(() => this.sendStdin("\r"), t + ENTER_DELAY_MS); // confirm (separate write)
                at += QUESTION_GAP_MS;
            }
            else {
                let cursor = 0;
                for (const idx of indexes) {
                    const down = "\x1b[B".repeat(idx - cursor);
                    if (down)
                        setTimeout(() => this.sendStdin(down), at);
                    setTimeout(() => this.sendStdin(" "), at + ENTER_DELAY_MS); // toggle
                    cursor = idx;
                    at += QUESTION_GAP_MS;
                }
                setTimeout(() => this.sendStdin("\x1b[C"), at); // next question
                at += QUESTION_GAP_MS;
            }
        }
        // Backstop: if the answer never registers (PostToolUse doesn't resolve
        // the question), re-send Enter — the cursor stays put so a later Enter
        // confirms. Tied to this question's id so it stops if it's superseded.
        if (!q.questions.at(-1)?.multiSelect) {
            this.retryEnter(q.toolUseId, at + ENTER_RETRY_MS, MAX_ENTER_RETRIES);
        }
        return true;
    }
    retryEnter(toolUseId, delay, left) {
        if (left <= 0)
            return;
        setTimeout(() => {
            if (this.question?.toolUseId !== toolUseId)
                return; // resolved or superseded
            this.sendStdin("\r");
            this.retryEnter(toolUseId, ENTER_RETRY_MS, left - 1);
        }, delay);
    }
    resolveQuestion(answers) {
        const q = this.question;
        if (!q)
            return;
        this.question = null;
        if (this.phase === "awaiting_question")
            this.phase = "busy";
        this.out({ type: "question_answer", answers: answers ?? skipAnswers(q.questions) });
    }
    // ── transcript drain (content stream) ──────────────────────────────
    /** Emit transcript records written since the cursor, in document order:
     *  assistant text → text_*; tool_use → tool_start; tool_result → tool_end.
     *  TodoWrite/AskUserQuestion are skipped (hook-owned UIs). */
    drain() {
        if (this.phase === "idle")
            return;
        if (!this.watcher)
            this.startWatch();
        const lines = this.readLines();
        if (this.cursor > lines.length)
            this.cursor = lines.length; // file shrank
        for (let i = this.cursor; i < lines.length; i++)
            this.processLine(lines[i]);
        this.cursor = lines.length;
    }
    processLine(line) {
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            return;
        }
        const content = o?.message?.content;
        if (o?.type === "assistant" && Array.isArray(content)) {
            for (const b of content) {
                if (b?.type === "text" && typeof b.text === "string" && b.text) {
                    this.emitText(b.text);
                }
                else if (b?.type === "thinking") {
                    // The transcript holds the whole (already-finished) thinking block,
                    // so emit the markers back-to-back — the protocol has no thinking-
                    // text message, only the status pair.
                    this.out({ type: "status", state: "think_start", sessionId: this.sessionId, provider: PROVIDER_NAME });
                    this.out({ type: "status", state: "think_end", sessionId: this.sessionId, provider: PROVIDER_NAME });
                }
                else if (b?.type === "tool_use") {
                    const name = String(b.name ?? "");
                    const id = String(b.id ?? "");
                    if (!name || !id || CONTROL_TOOLS.has(name))
                        continue;
                    const input = (b.input ?? {});
                    this.pendingTools.set(id, { name, input });
                    this.out({ type: "tool_start", name, toolId: id });
                    // Deferred permission_request for this tool fires now, right after
                    // its tool_start — so it lands after the narration text.
                    if (this.permission?.toolUseId === id)
                        this.emitPermissionRequest();
                }
            }
            return;
        }
        if (o?.type === "user" && Array.isArray(content)) {
            for (const b of content) {
                if (b?.type !== "tool_result")
                    continue;
                const id = String(b.tool_use_id ?? "");
                // The tool_result is the authoritative completion signal — it lands
                // for denials too (which fire no PostToolUse). Resolve a pending
                // permission here, before tool_end, with the decision read from the
                // result (a rejection message means denied).
                if (this.permission?.toolUseId === id) {
                    this.resolvePermission(isDenialResult(b.content) ? "denied" : "allowed");
                }
                const pend = this.pendingTools.get(id);
                if (!pend)
                    continue;
                this.pendingTools.delete(id);
                this.out({
                    type: "tool_end",
                    name: pend.name,
                    toolId: id,
                    summary: summarizeClaudeToolCall(pend.name, pend.input),
                    detail: { input: pend.input, output: stringifyToolResult(b.content) },
                });
            }
        }
    }
    emitText(text) {
        this.out({ type: "status", state: "text_start", sessionId: this.sessionId, provider: PROVIDER_NAME });
        this.out({ type: "text_delta", text });
        this.out({ type: "status", state: "text_end", sessionId: this.sessionId, provider: PROVIDER_NAME });
        this.lastText = text;
    }
    // ── internals ──────────────────────────────────────────────────────
    /** Resolve any open prompt negatively (used at turn boundaries). */
    resolveStale() {
        this.resolvePermission("denied");
        this.resolveQuestion(null);
    }
    result(success, text) {
        return {
            type: "result", success, text, sessionId: this.sessionId,
            costUsd: 0, turns: 0, durationMs: this.startMs ? Date.now() - this.startMs : 0,
            inputTokens: 0, outputTokens: 0, provider: PROVIDER_NAME,
        };
    }
    endTurn() {
        this.phase = "idle";
        this.submitting = false;
        this.stopWatch();
        this.startMs = 0;
        this.cursor = 0;
        this.pendingTools.clear();
        this.lastText = "";
        this.dispatchNext(); // send the next queued prompt, if any
    }
    startWatch() {
        if (this.watcher)
            return;
        const file = findSessionFile(this.sessionId);
        if (!file)
            return;
        try {
            const w = watch(file, () => {
                try {
                    this.drain();
                }
                catch { }
            });
            w.on("error", () => { });
            this.watcher = w;
        }
        catch { }
    }
    stopWatch() {
        if (this.watcher) {
            try {
                this.watcher.close();
            }
            catch { }
            this.watcher = null;
        }
    }
    /** Transcript as complete lines (drops a trailing partial line mid-write). */
    readLines() {
        const file = findSessionFile(this.sessionId);
        if (!file)
            return [];
        let data;
        try {
            data = readFileSync(file, "utf8");
        }
        catch {
            return [];
        }
        if (!data)
            return [];
        const endsClean = data.endsWith("\n");
        const lines = data.split("\n");
        if (lines.length && lines[lines.length - 1] === "")
            lines.pop();
        else if (!endsClean)
            lines.pop();
        return lines;
    }
    out(msg) {
        this.emit(this.sessionId, msg);
    }
}
/** Per-question chosen-option indexes from an app answer; [] = skip. */
function computeSelections(questions, answer) {
    let map = {};
    let broadcast = null;
    try {
        const parsed = JSON.parse(answer);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed))
                map[k] = String(v);
        }
        else {
            broadcast = String(parsed);
        }
    }
    catch {
        broadcast = answer;
    }
    return questions.map((q) => {
        const value = broadcast ?? map[q.question] ?? map[q.header] ?? "";
        const labels = q.multiSelect ? value.split(",").map((label) => label.trim()).filter(Boolean) : [value];
        const indexes = labels.map((label) => q.options.findIndex((o) => o.label === label));
        return indexes.some((idx) => idx < 0) ? [] : [...new Set(indexes)].sort((a, b) => a - b);
    });
}
function skipAnswers(questions) {
    const out = {};
    for (const q of questions)
        out[q.question || q.header || ""] = "skip";
    return out;
}
/** A tool_result whose content is claude's permission-rejection message. */
function isDenialResult(content) {
    const s = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return /doesn't want to proceed|tool use was rejected|user (rejected|denied)/i.test(s);
}
/** Flatten a transcript tool_result `content` into display text. */
function stringifyToolResult(content) {
    if (content === undefined || content === null)
        return undefined;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n");
    }
    try {
        return JSON.stringify(content);
    }
    catch {
        return String(content);
    }
}
