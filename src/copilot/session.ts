import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import type { EmitBridgeMessage } from "../integrations/contracts.js";
import {
  compactDetail,
  describeCopilotPermission,
  summarizeCopilotTool,
  summarizeCopilotToolResult,
} from "./summarize.js";

interface PendingResponse<T> {
  offered: Set<string>;
  start(): void;
  respond(value: unknown): boolean;
  cancel(): void;
  promise: Promise<T>;
}

interface PendingPermission {
  request: PermissionRequest;
  info: ReturnType<typeof describeCopilotPermission>;
  response: PendingResponse<PermissionRequestResult>;
  visible: boolean;
}

interface PendingQuestion {
  request: UserInputRequest;
  response: PendingResponse<UserInputResponse>;
  visible: boolean;
}

interface ToolState {
  name: string;
  summary: string;
  input: unknown;
}

type PermissionHandler = NonNullable<SessionConfig["onPermissionRequest"]>;
type UserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type UserInputRequest = Parameters<UserInputHandler>[0];
type UserInputResponse = Awaited<ReturnType<UserInputHandler>>;

function createPendingResponse<T>(
  timeoutMs: number,
  fallback: T,
  offered: string[],
  parse: (value: unknown) => T | undefined,
): PendingResponse<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function settle(value: T): void {
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

function questionAnswer(
  request: UserInputRequest,
  answer: unknown,
): UserInputResponse | undefined {
  let value = answer;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    value = record.answer ?? record[request.question];
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value);
  if (
    request.allowFreeform === false
    && request.choices?.length
    && !request.choices.includes(text)
  ) {
    return undefined;
  }
  return {
    answer: text,
    wasFreeform: !(request.choices ?? []).includes(text),
  };
}

export class CopilotSessionAdapter {
  private sdkSession?: CopilotSession;
  private unsubscribe?: () => void;
  private _busy = false;
  private promptQueue: string[] = [];
  private pendingPermissions: PendingPermission[] = [];
  private pendingQuestions: PendingQuestion[] = [];
  private streamedMessageIds = new Set<string>();
  private assistantMessages = new Map<string, string>();
  private tools = new Map<string, ToolState>();
  private thinking = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;
  private startedAt = 0;
  private lastError?: string;

  constructor(
    private readonly emit: EmitBridgeMessage,
    readonly id: string,
  ) {}

  get busy(): boolean {
    return this._busy;
  }

  get status(): "busy" | "idle" {
    return this._busy ? "busy" : "idle";
  }

  get session(): CopilotSession | undefined {
    return this.sdkSession;
  }

  sessionConfig(cwd?: string): SessionConfig {
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

  attach(session: CopilotSession): void {
    if (this.sdkSession) {
      throw new Error(`Copilot session ${this.id} is already attached`);
    }
    if (session.sessionId !== this.id) {
      throw new Error(
        `Copilot session ID mismatch: expected ${this.id}, received ${session.sessionId}`,
      );
    }
    this.sdkSession = session;
    this.unsubscribe = session.on((event) => this.handleEvent(event));
  }

  async run(text: string): Promise<void> {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.emit(this.id, { type: "error", message });
      this.finishTurn(false, message);
      throw error;
    }
  }

  respondPermission(decision: string): boolean {
    const pending = this.pendingPermissions[0];
    if (!pending?.visible || !pending.response.offered.has(decision)) {
      return false;
    }
    return pending.response.respond(decision);
  }

  respondQuestion(answer: unknown): boolean {
    const pending = this.pendingQuestions[0];
    return pending?.visible ? pending.response.respond(answer) : false;
  }

  async interrupt(): Promise<void> {
    if (!this.sdkSession || !this._busy) {
      return;
    }
    await this.sdkSession.abort();
  }

  async close(): Promise<void> {
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

  private beginTurn(): void {
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

  private handleEvent(event: SessionEvent): void {
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
        this.assistantMessages.set(
          event.data.messageId,
          (this.assistantMessages.get(event.data.messageId) ?? "")
            + event.data.deltaContent,
        );
        this.emit(this.id, {
          type: "text_delta",
          text: event.data.deltaContent,
        });
        break;
      case "assistant.message":
        this.endThinking();
        this.assistantMessages.set(
          event.data.messageId,
          event.data.content
            || this.assistantMessages.get(event.data.messageId)
            || "",
        );
        if (
          event.data.content
          && !this.streamedMessageIds.has(event.data.messageId)
        ) {
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
        this.finishTurn(
          !this.lastError && !event.data.aborted,
          event.data.aborted
            ? "Interrupted by user"
            : this.lastError || [...this.assistantMessages.values()]
              .filter(Boolean)
              .join("\n\n"),
        );
        break;
    }
  }

  private finishTurn(success: boolean, text: string): void {
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

  private dispatchNext(): void {
    const next = this.promptQueue.shift();
    if (!next) {
      return;
    }
    this.run(next).catch((error) => {
      console.error(
        `[copilot-session] Failed to dispatch queued prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private endThinking(): void {
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

  private async handlePermission(
    request: Parameters<PermissionHandler>[0],
  ): Promise<PermissionRequestResult> {
    const info = describeCopilotPermission(request);
    const offered = ["allow", "deny"];
    const pending = createPendingResponse<PermissionRequestResult>(
      60_000,
      { kind: "reject", feedback: "Timed out waiting for user approval" },
      offered,
      (value) => {
        if (value === "allow") {
          return { kind: "approve-once" };
        }
        if (value === "deny") {
          return { kind: "reject", feedback: "Denied by user" };
        }
        return undefined;
      },
    );
    const item: PendingPermission = {
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
    } finally {
      const index = this.pendingPermissions.indexOf(item);
      if (index >= 0) {
        this.pendingPermissions.splice(index, 1);
      }
      this.emitNextPermission();
    }
  }

  private async handleQuestion(
    request: UserInputRequest,
  ): Promise<UserInputResponse> {
    const pending = createPendingResponse<UserInputResponse>(
      120_000,
      { answer: "skip", wasFreeform: true },
      [],
      (value) => questionAnswer(request, value),
    );
    const item: PendingQuestion = {
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
    } finally {
      const index = this.pendingQuestions.indexOf(item);
      if (index >= 0) {
        this.pendingQuestions.splice(index, 1);
      }
      this.emitNextQuestion();
    }
  }

  private emitNextPermission(): void {
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

  private emitNextQuestion(): void {
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

  private cancelPending(): void {
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
