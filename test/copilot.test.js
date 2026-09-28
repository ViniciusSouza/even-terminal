import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCopilotClientManager } from "../dist/copilot/client.js";
import { createCopilotProvider } from "../dist/copilot/provider.js";
import { CopilotSessionAdapter } from "../dist/copilot/session.js";
import { mapCopilotHistory } from "../dist/copilot/storage.js";
import { summarizeCopilotToolResult } from "../dist/copilot/summarize.js";

class FakeSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.handlers = new Set();
    this.sent = [];
    this.events = [];
    this.abortCount = 0;
    this.disconnectCount = 0;
  }

  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event) {
    this.events.push(event);
    for (const handler of this.handlers) handler(event);
  }

  async send(options) {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  async abort() {
    this.abortCount += 1;
  }

  async disconnect() {
    this.disconnectCount += 1;
  }

  async getEvents() {
    return this.events;
  }
}

function event(type, data) {
  return {
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type,
    data,
  };
}

test("Copilot client manager shares startup and stops the active client", async () => {
  let factoryCalls = 0;
  let starts = 0;
  let stops = 0;
  const client = {
    async start() { starts += 1; },
    async stop() { stops += 1; return []; },
  };
  const manager = createCopilotClientManager(() => {
    factoryCalls += 1;
    return client;
  });

  const [first, second] = await Promise.all([
    manager.getClient(),
    manager.getClient(),
  ]);

  assert.equal(first, client);
  assert.equal(second, client);
  assert.equal(factoryCalls, 1);
  assert.equal(starts, 1);
  assert.deepEqual(await manager.stop(), []);
  assert.equal(stops, 1);
});

test("Copilot client reads GitHub authentication from a token file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "even-terminal-copilot-"));
  const tokenFile = join(directory, "token");
  writeFileSync(tokenFile, "test-token\n");
  const previousFile = process.env.COPILOT_GITHUB_TOKEN_FILE;
  const previousToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN_FILE = tokenFile;
  process.env.COPILOT_GITHUB_TOKEN = "ignored-token";
  let options;

  try {
    const manager = createCopilotClientManager((received) => {
      options = received;
      return {
        async start() {},
        async stop() { return []; },
      };
    });
    await manager.getClient();
    assert.equal(options.gitHubToken, "test-token");
    await manager.stop();
  } finally {
    if (previousFile === undefined) {
      delete process.env.COPILOT_GITHUB_TOKEN_FILE;
    } else {
      process.env.COPILOT_GITHUB_TOKEN_FILE = previousFile;
    }
    if (previousToken === undefined) {
      delete process.env.COPILOT_GITHUB_TOKEN;
    } else {
      process.env.COPILOT_GITHUB_TOKEN = previousToken;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Copilot client manager stops clients during startup and after startup failure", async () => {
  let releaseStart;
  let stops = 0;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const manager = createCopilotClientManager(() => ({
    async start() { await startGate; },
    async stop() { stops += 1; return []; },
  }));

  const starting = manager.getClient();
  assert.deepEqual(await manager.stop(), []);
  assert.equal(stops, 1);
  releaseStart();
  await starting;

  let cleanupStops = 0;
  const failingManager = createCopilotClientManager(() => ({
    async start() { throw new Error("startup failed"); },
    async stop() { cleanupStops += 1; return []; },
  }));
  await assert.rejects(failingManager.getClient(), /startup failed/);
  assert.equal(cleanupStops, 1);
});

test("Copilot adapter streams once, queues prompts, and completes on idle", async () => {
  const messages = [];
  const session = new FakeSession("session-1");
  const adapter = new CopilotSessionAdapter(
    (_sessionId, message) => messages.push(message),
    session.sessionId,
  );
  adapter.attach(session);

  await adapter.run("first");
  await adapter.run("second");
  assert.equal(session.sent.length, 1);

  session.emit(event("assistant.turn_start", { turnId: "1" }));
  session.emit(event("assistant.message_delta", {
    messageId: "answer-1",
    deltaContent: "Hello",
  }));
  session.emit(event("assistant.message", {
    messageId: "answer-1",
    content: "Hello",
  }));
  session.emit(event("assistant.usage", {
    model: "test",
    inputTokens: 3,
    outputTokens: 2,
    cost: 0.5,
  }));
  session.emit(event("session.idle", {}));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    messages.filter((message) => message.type === "text_delta").length,
    1,
  );
  const result = messages.find((message) => message.type === "result");
  assert.equal(typeof result.durationMs, "number");
  const { durationMs, ...stableResult } = result;
  assert.ok(durationMs >= 0);
  assert.deepEqual(stableResult, {
    type: "result",
    success: true,
    text: "Hello",
    sessionId: "session-1",
    provider: "copilot",
    turns: 1,
    inputTokens: 3,
    outputTokens: 2,
    costUsd: 0,
  });
  assert.equal(session.sent.length, 2);
  assert.deepEqual(session.sent[1], { prompt: "second" });
});

test("Copilot permission and question callbacks require bridge responses", async () => {
  const messages = [];
  const adapter = new CopilotSessionAdapter(
    (_sessionId, message) => messages.push(message),
    "session-2",
  );
  const config = adapter.sessionConfig("C:\\repo");

  const permission = config.onPermissionRequest({
    kind: "shell",
    fullCommandText: "npm test",
    intention: "Run tests",
    commands: [],
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
  }, { sessionId: "session-2" });
  assert.equal(adapter.respondPermission("allowAlways"), false);
  assert.equal(adapter.respondPermission("allow"), true);
  assert.deepEqual(await permission, { kind: "approve-once" });

  const question = config.onUserInputRequest({
    question: "Choose",
    choices: ["A", "B"],
    allowFreeform: true,
  }, { sessionId: "session-2" });
  assert.equal(adapter.respondQuestion("B"), true);
  assert.deepEqual(await question, { answer: "B", wasFreeform: false });

  assert.equal(
    messages.some((message) => message.type === "permission_request"),
    true,
  );
  assert.equal(
    messages.some((message) => message.type === "user_question"),
    true,
  );
});

test("Copilot serializes permission and question requests", async () => {
  const messages = [];
  const adapter = new CopilotSessionAdapter(
    (_sessionId, message) => messages.push(message),
    "session-queue",
  );
  const config = adapter.sessionConfig("C:\\repo");
  const permissionRequest = (command, toolCallId) => ({
    kind: "shell",
    fullCommandText: command,
    intention: `Run ${command}`,
    commands: [],
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: false,
    toolCallId,
  });
  const firstPermission = config.onPermissionRequest(
    permissionRequest("first", "permission-1"),
    { sessionId: "session-queue" },
  );
  const secondPermission = config.onPermissionRequest(
    permissionRequest("second", "permission-2"),
    { sessionId: "session-queue" },
  );

  assert.deepEqual(
    messages
      .filter((message) => message.type === "permission_request")
      .map((message) => message.toolUseId),
    ["permission-1"],
  );
  assert.equal(adapter.respondPermission("allow"), true);
  assert.deepEqual(await firstPermission, { kind: "approve-once" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    messages
      .filter((message) => message.type === "permission_request")
      .map((message) => message.toolUseId),
    ["permission-1", "permission-2"],
  );
  assert.equal(adapter.respondPermission("deny"), true);
  assert.deepEqual(await secondPermission, {
    kind: "reject",
    feedback: "Denied by user",
  });

  const firstQuestion = config.onUserInputRequest({
    question: "First",
    choices: ["A", "B"],
    allowFreeform: false,
  }, { sessionId: "session-queue" });
  const secondQuestion = config.onUserInputRequest({
    question: "Second",
    choices: ["C", "D"],
    allowFreeform: false,
  }, { sessionId: "session-queue" });
  assert.equal(adapter.respondQuestion("invalid"), false);
  assert.equal(adapter.respondQuestion("A"), true);
  assert.deepEqual(await firstQuestion, { answer: "A", wasFreeform: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.respondQuestion("D"), true);
  assert.deepEqual(await secondQuestion, { answer: "D", wasFreeform: false });

  const questions = messages.filter((message) => message.type === "user_question");
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0].questions[0].options, [
    { label: "A", description: "", preview: "" },
    { label: "B", description: "", preview: "" },
  ]);
});

test("Copilot adapter maps tools, failures, and object question answers", async () => {
  const messages = [];
  const session = new FakeSession("session-events");
  const adapter = new CopilotSessionAdapter(
    (_sessionId, message) => messages.push(message),
    session.sessionId,
  );
  adapter.attach(session);

  await adapter.run("inspect");
  session.emit(event("assistant.reasoning_delta", { deltaContent: "private" }));
  session.emit(event("tool.execution_start", {
    toolCallId: "tool-1",
    toolName: "shell",
    arguments: { command: "npm test" },
  }));
  session.emit(event("tool.execution_complete", {
    toolCallId: "tool-1",
    success: false,
    error: { message: "tests failed" },
  }));
  session.emit(event("session.error", {
    errorType: "tool_error",
    message: "Copilot turn failed",
  }));
  session.emit(event("session.idle", { aborted: false }));

  assert.equal(
    messages.some((message) =>
      message.type === "status" && message.state === "think_start"
    ),
    true,
  );
  assert.equal(
    messages.some((message) =>
      message.type === "status" && message.state === "think_end"
    ),
    true,
  );
  assert.deepEqual(
    messages.find((message) => message.type === "tool_start"),
    { type: "tool_start", name: "shell", toolId: "tool-1" },
  );
  assert.deepEqual(
    messages.find((message) => message.type === "tool_end"),
    {
      type: "tool_end",
      name: "shell",
      toolId: "tool-1",
      summary: "Shell npm test",
      detail: {
        input: { command: "npm test" },
        output: "tests failed",
        success: false,
      },
    },
  );
  const result = messages.find((message) => message.type === "result");
  assert.equal(result.success, false);
  assert.equal(result.text, "Copilot turn failed");
  assert.equal(
    messages.some((message) =>
      JSON.stringify(message).includes("private")
    ),
    false,
  );

  const config = adapter.sessionConfig("C:\\repo");
  const question = config.onUserInputRequest({
    question: "Choose",
    choices: ["A", "B"],
    allowFreeform: true,
  }, { sessionId: session.sessionId });
  assert.equal(adapter.respondQuestion({ Choose: "A" }), true);
  assert.deepEqual(await question, { answer: "A", wasFreeform: false });
});

test("Copilot provider creates stable SDK sessions through the integration contract", async () => {
  const created = [];
  const manager = {
    async getClient() {
      return {
        async createSession(config) {
          created.push(config);
          return new FakeSession(config.sessionId);
        },
      };
    },
    async stop() { return []; },
  };
  const provider = createCopilotProvider(() => {}, manager);

  const result = await provider.prompt(undefined, "hello", "C:\\repo");

  assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.provider, "copilot");
  assert.equal(created[0].sessionId, result.sessionId);
  assert.equal(created[0].workingDirectory, "C:\\repo");
  assert.equal(created[0].streaming, true);
  assert.deepEqual(provider.getStatus(result.sessionId), {
    state: "busy",
    provider: "copilot",
  });
});

test("Copilot provider shares concurrent resume and maps missing sessions", async () => {
  let resumeCalls = 0;
  let releaseResume;
  const resumeGate = new Promise((resolve) => {
    releaseResume = resolve;
  });
  const manager = {
    async getClient() {
      return {
        async resumeSession(sessionId) {
          resumeCalls += 1;
          await resumeGate;
          return new FakeSession(sessionId);
        },
      };
    },
    async stop() { return []; },
  };
  const provider = createCopilotProvider(() => {}, manager);
  const first = provider.prompt("existing", "first");
  const second = provider.prompt("existing", "second");
  releaseResume();

  assert.deepEqual(await Promise.all([first, second]), [
    { sessionId: "existing", provider: "copilot" },
    { sessionId: "existing", provider: "copilot" },
  ]);
  assert.equal(resumeCalls, 1);

  const missingProvider = createCopilotProvider(() => {}, {
    async getClient() {
      return {
        async resumeSession() {
          throw new Error("session not found");
        },
      };
    },
    async stop() { return []; },
  });
  await assert.rejects(
    missingProvider.prompt("missing", "hello"),
    (error) => error.statusCode === 404,
  );
});

test("Copilot history excludes reasoning and keeps conversation events", () => {
  const events = [
    event("user.message", { content: "Question" }),
    event("assistant.reasoning", { content: "private reasoning" }),
    event("assistant.message", {
      messageId: "answer",
      content: "Answer",
    }),
  ];

  assert.deepEqual(mapCopilotHistory(events, 10), [
    { role: "user", text: "Question" },
    { role: "assistant", text: "Answer" },
  ]);
});

test("Copilot tool summaries omit detailed output and bound bridge content", () => {
  const detailedContent = "sensitive detail ".repeat(1000);
  const content = "x".repeat(5000);
  const summary = summarizeCopilotToolResult({
    toolCallId: "tool",
    success: true,
    result: { content, detailedContent },
  });

  assert.equal(summary.includes("sensitive detail"), false);
  assert.equal(summary.endsWith("... [truncated]"), true);
  assert.ok(summary.length < content.length);
});
