import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

import express from "express";

import {
  getDefaultProvider,
  isProvider,
  parseProvider,
  SUPPORTED_PROVIDERS,
} from "../dist/session.js";
import { redactTokenQueryParam } from "../dist/http-log.js";
import { CliIntegrationRegistry } from "../dist/integrations/registry.js";
import coreRouter, { getProvider } from "../dist/routes/core.js";
import { fileName, oneLine, truncate } from "../dist/summary-format.js";

test("published providers remain available through the reconstructed build", () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, ["claude", "claude-sync", "codex"]);
  assert.equal(isProvider("codex"), true);
  assert.equal(isProvider("copilot"), false);
  assert.equal(parseProvider("claude-sync"), "claude-sync");
  assert.throws(() => parseProvider("unknown"), /Unsupported provider/);
});

test("every supported provider is registered with the bridge contract", () => {
  const requiredMethods = [
    "listSessions",
    "getSessionStatus",
    "getInfo",
    "getHistory",
    "prompt",
    "respondPermission",
    "respondQuestion",
    "interrupt",
    "getStatus",
  ];

  for (const name of SUPPORTED_PROVIDERS) {
    const provider = getProvider(name);
    for (const method of requiredMethods) {
      assert.equal(
        typeof provider[method],
        "function",
        `${name} provider must implement ${method}`,
      );
    }
  }
});

test("CLI integration registry validates plugins and protects names", () => {
  const integration = {
    listSessions: async () => [],
    getSessionStatus: async () => "idle",
    getInfo: async () => ({ provider: "example" }),
    getHistory: async () => [],
    prompt: async () => ({ sessionId: "session", provider: "example" }),
    respondPermission: () => true,
    respondQuestion: () => true,
    interrupt: () => {},
    getStatus: () => ({ state: "idle", provider: "example" }),
  };
  const registry = new CliIntegrationRegistry();

  registry.register({ name: "example", integration });

  assert.equal(registry.get("example"), integration);
  assert.deepEqual(registry.names(), ["example"]);
  assert.throws(
    () => registry.register({ name: "example", integration }),
    /already registered/,
  );
  assert.throws(
    () => registry.register({ name: "incomplete", integration: {} }),
    /must implement listSessions/,
  );
});

test("interrupt endpoint reports asynchronous integration failures", async () => {
  const provider = getProvider("claude");
  const originalGetStatus = provider.getStatus;
  const originalInterrupt = provider.interrupt;
  const app = express();
  app.use(express.json());
  app.use(coreRouter);
  const server = createServer(app);

  provider.getStatus = () => ({ state: "busy", provider: "claude" });
  provider.interrupt = async () => {
    throw new Error("interrupt failed");
  };

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/interrupt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "session",
          provider: "claude",
        }),
      },
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "interrupt failed" });
  } finally {
    provider.getStatus = originalGetStatus;
    provider.interrupt = originalInterrupt;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("default provider honors the environment contract", () => {
  const previous = process.env.DEFAULT_PROVIDER;
  try {
    delete process.env.DEFAULT_PROVIDER;
    assert.equal(getDefaultProvider(), "claude");
    process.env.DEFAULT_PROVIDER = "codex";
    assert.equal(getDefaultProvider(), "codex");
  } finally {
    if (previous === undefined) {
      delete process.env.DEFAULT_PROVIDER;
    } else {
      process.env.DEFAULT_PROVIDER = previous;
    }
  }
});

test("HTTP logging redacts only the pairing token", () => {
  assert.equal(redactTokenQueryParam("/api/info"), "/api/info");
  assert.equal(
    redactTokenQueryParam("/api/info?provider=codex&token=secret"),
    "/api/info?provider=codex&token=REDACTED",
  );
});

test("HUD formatting keeps output short and single-line", () => {
  assert.equal(fileName("C:\\projects\\demo\\README.md"), "README.md");
  assert.equal(oneLine("  first\nsecond  "), "first second");
  assert.equal(truncate("123456", 4), "1234...");
});

test("CLI reports the package version", () => {
  const output = execFileSync(
    process.execPath,
    ["bin/cli.js", "--version"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );

  assert.equal(output.trim(), "0.10.4");
});
