import { compactDetail, describeCopilotPermission, summarizeCopilotTool, summarizeCopilotToolResult, } from "./summarize.js";
function createPendingResponse(timeoutMs, fallback, offered, parse) {
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => {
        resolvePromise = resolve;
    });
    let timer;
    function settle(value) {
        if (settled) {
            return;
        }
        settled = true;
        if (timer) {
            clearTimeout(timer);
        }
        resolvePromise(value);
    }
    return {
        offered: new Set(offered),
        promise,
        start() {
            if (settled || timer) {
                return;
            }
            timer = setTimeout(() => settle(fallback), timeoutMs);
            timer.unref();
        },
        respond(value) {
            if (settled) {
                return false;
            }
            const parsed = parse(value);
            if (parsed === undefined) {
                return false;
            }
            settle(parsed);
            return true;
        },
        cancel() {
            settle(fallback);
        },
    };
}
function questionAnswer(request, answer) {
    let value = answer;
    if (value && typeof value === "object") {
        const record = value;
        value = record.answer ?? record[request.question];
    }
    if (value === undefined || value === null) {
        return undefined;
    }
    const text = String(value);
    if (request.allowFreeform === false
        && request.choices?.length
        && !request.choices.includes(text)) {
        return undefined;
    }
    return {
        answer: text,
        wasFreeform: !(request.choices ?? []).includes(text),
    };
}
export class CopilotSessionAdapter {
    emit;
    id;
    sdkSession;
    unsubscribe;
    _busy = false;
    promptQueue = [];
    pendingPermissions = [];
    pendingQuestions = [];
    streamedMessageIds = new Set();
    assistantMessages = new Map();
    tools = new Map();
    thinking = false;
    inputTokens = 0;
    outputTokens = 0;
    turns = 0;
    startedAt = 0;
    lastError;
    constructor(emit, id) {
        this.emit = emit;
        this.id = id;
    }
    get busy() {
        return this._busy;
    }
    get status() {
        return this._busy ? "busy" : "idle";
    }
    get session() {
        return this.sdkSession;
    }
    sessionConfig(cwd) {
        return {
            clientName: "even-terminal",
            workingDirectory: cwd,
            model: process.env.COPILOT_MODEL?.trim() || undefined,
            streaming: true,
            includeSubAgentStreamingEvents: false,
            reasoningSummary: "none",
            onPermissionRequest: (request) => this.handlePermission(request),
            onUserInputRequest: (request) => this.handleQuestion(request),
        };
    }
    attach(session) {
        if (this.sdkSession) {
            throw new Error(`Copilot session ${this.id} is already attached`);
        }
        if (session.sessionId !== this.id) {
            throw new Error(`Copilot session ID mismatch: expected ${this.id}, received ${session.sessionId}`);
        }
        this.sdkSession = session;
        this.unsubscribe = session.on((event) => this.handleEvent(event));
    }
    async run(text) {
        if (this._busy) {
            this.promptQueue.push(text);
            return;
        }
        const session = this.sdkSession;
        if (!session) {
            throw new Error(`Copilot session ${this.id} is not attached`);
        }
        this.beginTurn();
        this.emit(this.id, { type: "user_prompt", text });
        this.emit(this.id, {
            type: "status",
            state: "busy",
            sessionId: this.id,
        });
        try {
            await session.send({ prompt: text });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = message;
            this.emit(this.id, { type: "error", message });
            this.finishTurn(false, message);
            throw error;
        }
    }
    respondPermission(decision) {
        const pending = this.pendingPermissions[0];
        if (!pending?.visible || !pending.response.offered.has(decision)) {
            return false;
        }
        return pending.response.respond(decision);
    }
    respondQuestion(answer) {
        const pending = this.pendingQuestions[0];
        return pending?.visible ? pending.response.respond(answer) : false;
    }
    async interrupt() {
        if (!this.sdkSession || !this._busy) {
            return;
        }
        await this.sdkSession.abort();
    }
    async close() {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.cancelPending();
        this.promptQueue.length = 0;
        const session = this.sdkSession;
        this.sdkSession = undefined;
        if (session) {
            await session.disconnect();
        }
    }
    beginTurn() {
        this._busy = true;
        this.streamedMessageIds.clear();
        this.assistantMessages.clear();
        this.tools.clear();
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.turns = 0;
        this.startedAt = Date.now();
        this.lastError = undefined;
    }
    handleEvent(event) {
        if (event.agentId) {
            return;
        }
        switch (event.type) {
            case "assistant.turn_start":
                this.turns += 1;
                break;
            case "assistant.reasoning_delta":
                if (!this.thinking) {
                    this.thinking = true;
                    this.emit(this.id, {
                        type: "status",
                        state: "think_start",
                        sessionId: this.id,
                    });
                }
                break;
            case "assistant.message_delta":
                this.endThinking();
                this.streamedMessageIds.add(event.data.messageId);
                this.assistantMessages.set(event.data.messageId, (this.assistantMessages.get(event.data.messageId) ?? "")
                    + event.data.deltaContent);
                this.emit(this.id, {
                    type: "text_delta",
                    text: event.data.deltaContent,
                });
                break;
            case "assistant.message":
                this.endThinking();
                this.assistantMessages.set(event.data.messageId, event.data.content
                    || this.assistantMessages.get(event.data.messageId)
                    || "");
                if (event.data.content
                    && !this.streamedMessageIds.has(event.data.messageId)) {
                    this.emit(this.id, {
                        type: "text_delta",
                        text: event.data.content,
                    });
                }
                break;
            case "tool.execution_start": {
                this.endThinking();
                const summary = summarizeCopilotTool(event.data);
                this.tools.set(event.data.toolCallId, {
                    name: event.data.toolName,
                    summary,
                    input: event.data.arguments,
                });
                this.emit(this.id, {
                    type: "tool_start",
                    name: event.data.toolName,
                    toolId: event.data.toolCallId,
                });
                break;
            }
            case "tool.execution_complete": {
                const tool = this.tools.get(event.data.toolCallId);
                this.tools.delete(event.data.toolCallId);
                this.emit(this.id, {
                    type: "tool_end",
                    name: tool?.name || "Tool",
                    toolId: event.data.toolCallId,
                    summary: tool?.summary || tool?.name || "Tool",
                    detail: {
                        input: tool?.input,
                        output: summarizeCopilotToolResult(event.data),
                        success: event.data.success,
                    },
                });
                break;
            }
            case "assistant.usage":
                this.inputTokens += event.data.inputTokens ?? 0;
                this.outputTokens += event.data.outputTokens ?? 0;
                break;
            case "session.error":
                this.lastError = event.data.message;
                this.emit(this.id, {
                    type: "error",
                    message: event.data.message,
                    code: event.data.errorCode || event.data.errorType,
                });
                break;
            case "session.idle":
                this.finishTurn(!this.lastError && !event.data.aborted, event.data.aborted
                    ? "Interrupted by user"
                    : this.lastError || [...this.assistantMessages.values()]
                        .filter(Boolean)
                        .join("\n\n"));
                break;
        }
    }
    finishTurn(success, text) {
        if (!this._busy) {
            return;
        }
        this.endThinking();
        this._busy = false;
        this.cancelPending();
        this.emit(this.id, {
            type: "result",
            success,
            text,
            sessionId: this.id,
            provider: "copilot",
            turns: this.turns,
            durationMs: Math.max(0, Date.now() - this.startedAt),
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            costUsd: 0,
        });
        this.emit(this.id, {
            type: "status",
            state: "idle",
            sessionId: this.id,
        });
        this.dispatchNext();
    }
    dispatchNext() {
        const next = this.promptQueue.shift();
        if (!next) {
            return;
        }
        this.run(next).catch((error) => {
            console.error(`[copilot-session] Failed to dispatch queued prompt: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    endThinking() {
        if (!this.thinking) {
            return;
        }
        this.thinking = false;
        this.emit(this.id, {
            type: "status",
            state: "think_end",
            sessionId: this.id,
        });
    }
    async handlePermission(request) {
        const info = describeCopilotPermission(request);
        const offered = ["allow", "deny"];
        const pending = createPendingResponse(60_000, { kind: "reject", feedback: "Timed out waiting for user approval" }, offered, (value) => {
            if (value === "allow") {
                return { kind: "approve-once" };
            }
            if (value === "deny") {
                return { kind: "reject", feedback: "Denied by user" };
            }
            return undefined;
        });
        const item = {
            request,
            info,
            response: pending,
            visible: false,
        };
        this.pendingPermissions.push(item);
        this.emitNextPermission();
        try {
            const result = await pending.promise;
            this.emit(this.id, {
                type: "permission_result",
                toolName: info.toolName,
                summary: info.description,
                decision: result.kind === "approve-once" ? "allowed" : "denied",
            });
            return result;
        }
        finally {
            const index = this.pendingPermissions.indexOf(item);
            if (index >= 0) {
                this.pendingPermissions.splice(index, 1);
            }
            this.emitNextPermission();
        }
    }
    async handleQuestion(request) {
        const pending = createPendingResponse(120_000, { answer: "skip", wasFreeform: true }, [], (value) => questionAnswer(request, value));
        const item = {
            request,
            response: pending,
            visible: false,
        };
        this.pendingQuestions.push(item);
        this.emitNextQuestion();
        try {
            const answer = await pending.promise;
            this.emit(this.id, {
                type: "question_answer",
                answers: { [request.question]: answer.answer },
            });
            return answer;
        }
        finally {
            const index = this.pendingQuestions.indexOf(item);
            if (index >= 0) {
                this.pendingQuestions.splice(index, 1);
            }
            this.emitNextQuestion();
        }
    }
    emitNextPermission() {
        const pending = this.pendingPermissions[0];
        if (!pending || pending.visible) {
            return;
        }
        pending.visible = true;
        pending.response.start();
        this.emit(this.id, {
            type: "permission_request",
            toolName: pending.info.toolName,
            description: pending.info.description,
            detail: compactDetail(pending.info.detail),
            toolUseId: pending.request.toolCallId,
            options: [
                { text: "Allow once", key: "allow" },
                { text: "Deny", key: "deny" },
            ],
        });
    }
    emitNextQuestion() {
        const pending = this.pendingQuestions[0];
        if (!pending || pending.visible) {
            return;
        }
        pending.visible = true;
        pending.response.start();
        this.emit(this.id, {
            type: "user_question",
            questions: [{
                    question: pending.request.question,
                    options: (pending.request.choices ?? []).map((choice) => ({
                        label: choice,
                        description: "",
                        preview: "",
                    })),
                    multiSelect: false,
                }],
        });
    }
    cancelPending() {
        const permissions = this.pendingPermissions.splice(0);
        const questions = this.pendingQuestions.splice(0);
        for (const pending of permissions) {
            pending.response.cancel();
        }
        for (const pending of questions) {
            pending.response.cancel();
        }
    }
}
