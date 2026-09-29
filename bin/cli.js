#!/usr/bin/env node

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, networkInterfaces } from "node:os";
import { connect as netConnect, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { createInterface, emitKeypressEvents } from "node:readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { getExposeProviderNames } from "../dist/expose/registry.js";
import { SUPPORTED_PROVIDERS } from "../dist/session.js";
import { spawnSyncShim } from "../dist/util/spawn-shim.js";
import {
  CONFIG_KEYS,
  CONFIG_VERSION,
  createDefaultConfig,
  formatConfig,
  generateToken,
  loadConfig,
  maskToken,
  parseClaudeAllowedTools,
  resolveConfigPath,
  resolveStartupEnvironment,
  resolveUserPath,
  saveConfig,
  updateConfig,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const INSTANCE_DIR = join(homedir(), ".even-terminal", "instances");
const exposeProviderNames = getExposeProviderNames();
const exposeProviderList = exposeProviderNames.join(", ");
const providerNames = [...SUPPORTED_PROVIDERS];
const configCompletionDefinitions = new Map([
  ["provider", {
    description: "Set the default agent",
    values: [
      ["claude", "Claude"],
      ["claude-sync", "Claude Sync"],
      ["codex", "Codex"],
      ["copilot", "GitHub Copilot"],
    ],
  }],
  ["cwd", { description: "Set the default project directory" }],
  ["network", {
    description: "Set the default network mode",
    values: [
      ["lan", "Local network"],
      ["tailscale", "Tailscale"],
      ["interface:", "Named network interface"],
      ...exposeProviderNames.map((name) => [`expose:${name}`, `Expose through ${name}`]),
    ],
  }],
  ["port", { description: "Set the server port" }],
  ["token", { description: "Replace the pairing token" }],
  ["name", {
    description: "Set or clear the display name",
    values: [["default", "Clear the display name"], ["none", "Clear the display name"]],
  }],
  ["claudeUseSystemCli", {
    description: "Select the Claude executable",
    values: [["on", "Use the system Claude CLI"], ["off", "Use the SDK-bundled Claude CLI"]],
  }],
  ["claudeAllowedTools", {
    description: "Set Claude SDK automatically approved tools",
    values: [["default", "Restore the default list"], ["none", "Clear the list"]],
  }],
]);
const optionDefinitions = {
  port: {
    alias: "p",
    type: "number",
    describe: "Server port",
  },
  token: {
    alias: "t",
    type: "string",
    describe: "Override the persistent auth token for this run",
  },
  name: {
    alias: "n",
    type: "string",
    describe: "Client display name",
  },
  cwd: {
    alias: "d",
    type: "string",
    describe: "Project directory (where Claude Code sessions live)",
  },
  provider: {
    type: "string",
    choices: providerNames,
    describe: "Default AI provider",
  },
  force: {
    type: "boolean",
    default: undefined,
    describe: "Ignore any provider requested by the client; always use --provider",
  },
  config: {
    type: "string",
    requiresArg: true,
    describe: "Use another config file (default: ~/.even-terminal/config.json)",
  },
  lan: {
    type: "boolean",
    default: undefined,
    describe: "Use the detected LAN address",
  },
  tailscale: {
    type: "boolean",
    default: undefined,
    describe: "Use Tailscale IPv4 address instead of LAN",
  },
  interface: {
    alias: ["i", "if"],
    type: "string",
    describe: "Bind to the IPv4 address of the named network interface",
  },
  "allow-cors": {
    type: "boolean",
    describe: "Allow cross-origin browser requests",
  },
  expose: {
    type: "string",
    array: true,
    requiresArg: true,
    choices: exposeProviderNames,
    describe: `Quick public expose provider (${exposeProviderList})`,
  },
  "log-file": {
    type: "string",
    describe: "Write logs to a file (default: ./even-terminal-<ts>.log)",
  },
  "log-level": {
    type: "string",
    choices: ["debug", "info"],
    default: "debug",
    describe: "Log-file detail only; 'info' omits raw diagnostics",
  },
  verbose: {
    type: "boolean",
    describe: "Print raw diagnostics to stdout only; does not change log files",
  },
  "use-original-claude": {
    type: "boolean",
    default: undefined,
    describe: "Use the original Claude SDK provider without terminal/app synchronization.",
  },
  "claude-use-system-cli": {
    type: "boolean",
    default: undefined,
    describe: "Use the system Claude CLI for SDK sessions instead of the SDK-bundled version (compatibility workaround).",
  },
  "claude-allowed-tools": {
    type: "string",
    requiresArg: true,
    describe: "Replace the default Claude SDK auto-approved tool list (comma-separated, or 'none').",
  },
};

function registerCompletionOption(command, name, option) {
  const aliases = option.alias === undefined
    ? []
    : Array.isArray(option.alias) ? option.alias : [option.alias];
  const alias = aliases.find((value) => value.length === 1);
  if (option.choices) {
    command.option(name, option.describe, (done) => {
      for (const value of option.choices) done(value, value);
    }, alias);
  } else if (option.type === "boolean") {
    command.option(name, option.describe, alias);
  } else {
    command.option(name, option.describe, () => {}, alias);
  }
  for (const longAlias of aliases.filter((value) => value.length > 1)) {
    if (option.choices) {
      command.option(longAlias, option.describe, (done) => {
        for (const value of option.choices) done(value, value);
      });
    } else if (option.type === "boolean") {
      command.option(longAlias, option.describe);
    } else {
      command.option(longAlias, option.describe, () => {});
    }
  }
}

function registerCompletionMetaOptions(command) {
  command.option("help", "Show help", "h");
  command.option("version", "Show version number", "v");
}

function registerCompletionOptions(command) {
  for (const [name, option] of Object.entries(optionDefinitions)) {
    registerCompletionOption(command, name, option);
  }
  registerCompletionMetaOptions(command);
}

function registerConfigCompletionOptions(command) {
  registerCompletionOption(command, "config", optionDefinitions.config);
  registerCompletionMetaOptions(command);
}

function registerYargsOptions(parser) {
  let next = parser;
  for (const [name, option] of Object.entries(optionDefinitions)) {
    next = next.option(name, option);
  }
  return next;
}

function configureConfigCommand(command) {
  return command
    .positional("key", {
      describe: "Config key to update",
      type: "string",
    })
    .positional("value", {
      describe: "New config value",
      type: "string",
    })
    .option("reset", {
      type: "boolean",
      default: false,
      describe: "Run the full setup wizard again",
    });
}

async function runConfigCli(args) {
  await yargs(args)
    .parserConfiguration({ "camel-case-expansion": false })
    .scriptName("even-terminal config")
    .usage("$0 [key] [value] [options]")
    .help("help").alias("h", "help")
    .version("version", "Show version number", pkg.version).alias("v", "version")
    .fail(failConcise)
    .option("config", optionDefinitions.config)
    .command("$0 [key] [value]", "View or change persistent configuration", configureConfigCommand, runConfigCommand)
    .strict()
    .parse();
}

function failConcise(message, error) {
  const detail = error instanceof Error ? error.message : message || "Invalid arguments";
  console.error(`error: ${detail}`);
  process.exit(1);
}

function registerCompletionCommands(root) {
  const start = root.command("start", "Start the server (default)");
  const config = root.command("config", "View or change persistent configuration");
  const complete = root.command("complete", "Print shell completion script for bash, zsh, fish, or powershell");
  root.command("claude", "Open Claude connected to a running Even Terminal server");
  root.command("codex", "Open Codex connected to a running Even Terminal server");
  root.command("copilot", "Start Even Terminal with GitHub Copilot selected");

  registerCompletionOptions(root);
  registerCompletionOptions(start);
  registerConfigCompletionOptions(config);
  config.option("reset", "Run the full setup wizard again");
  for (const key of CONFIG_KEYS) {
    const definition = configCompletionDefinitions.get(key);
    const command = root.command(`config ${key}`, definition.description);
    registerConfigCompletionOptions(command);
    command.argument("value", definition.values
      ? (done) => {
          for (const [value, description] of definition.values) done(value, description);
        }
      : undefined);
  }
  complete.argument("shell", (done) => {
    done("bash", "Bash shell");
    done("zsh", "Zsh shell");
    done("fish", "Fish shell");
    done("powershell", "PowerShell");
  });
}

async function runCompletion(shell, forwardedArgs = []) {
  const t = (await import("@bomb.sh/tab")).default;
  registerCompletionCommands(t);

  if (shell === "--") {
    t.parse(forwardedArgs);
  } else {
    t.setup("even-terminal", "even-terminal", shell);
  }
}

// ── Completion (bash/zsh/fish/powershell) ────────────
// Handled before yargs so "complete" isn't rejected by strict mode.

const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "complete") {
  await runCompletion(rawArgs[1], rawArgs.slice(2));
  process.exit(0);
}
if (rawArgs[0] === "config") {
  await runConfigCli(rawArgs.slice(1));
  process.exit(0);
}
if (rawArgs[0] === "codex") {
  await runCodex(rawArgs.slice(1));
  // unreachable — runCodex calls process.exit
}
if (rawArgs[0] === "claude") {
  await runClaude(rawArgs.slice(1));
  // unreachable — runClaude calls process.exit
}

// ── CLI ──────────────────────────────────────────────

registerYargsOptions(yargs(hideBin(process.argv))
  .parserConfiguration({ "camel-case-expansion": false })
  .scriptName("even-terminal")
  .help("help").alias("h", "help")
  .version("version", "Show version number", pkg.version).alias("v", "version")
  .fail(failConcise)
  .usage("$0 [command] [options]")
  .command("start", "Start the server (default)", {}, run)
  .command(
    "config [key] [value]",
    "View or change persistent configuration",
    configureConfigCommand,
    runConfigCommand,
  )
  .command(
    "complete <shell>",
    "Print shell completion script for bash, zsh, fish, or powershell",
    (command) => command.positional("shell", {
      describe: "Target shell (bash, zsh, fish, powershell)",
      choices: ["bash", "zsh", "fish", "powershell"],
      type: "string",
    }),
    async (argv) => {
      await runCompletion(argv.shell);
    },
  )
  .command(
    "codex [args..]",
    "Run Codex through Even Terminal (resume supported; other Codex arguments are forwarded without guarantees)",
  )
  .command(
    "claude [args..]",
    "Run Claude through Even Terminal (--resume supported; other Claude arguments are forwarded without guarantees)",
  )
  .command(
    "copilot",
    "Start Even Terminal with GitHub Copilot selected",
    {},
    (argv) => run({ ...argv, provider: "copilot" }),
  )
  .command("$0", false, {}, run))
  .check((argv) => {
    if ((argv.lan || argv.tailscale) && argv.expose?.length) {
      throw new Error("--expose cannot be combined with --lan or --tailscale");
    }
    const localModes = [argv.lan, argv.tailscale, argv.interface].filter(Boolean);
    if (localModes.length > 1) {
      throw new Error("--lan, --tailscale, and --interface are mutually exclusive");
    }
    if (Array.isArray(argv.expose) && argv.expose.length > 1) {
      throw new Error("only one --expose provider may be specified");
    }
    if (argv["claude-allowed-tools"] !== undefined) {
      parseClaudeAllowedTools(argv["claude-allowed-tools"]);
    }
    return true;
  })
  .group(["lan", "tailscale", "interface"], "Local network options:")
  .group(["expose"], "Quick public expose options:")
  .strict()
  .example("even-terminal", "Start with defaults")
  .example("even-terminal -p 8080", "Start on port 8080")
  .example("even-terminal -t mytoken123", "Start with a fixed token")
  .example("even-terminal config", "View or change persistent configuration")
  .example("npx even-terminal", "Run without installing")
  .example("even-terminal --expose pinggy", "Start with a quick public expose helper")
  .epilogue(
    "Quick public expose helpers are intended for simple temporary sharing, not long-term use.\n" +
    "For stable setups, prefer a proper network path such as Tailscale or a production tunnel configuration.\n\n" +
    "Persistent configuration:\n" +
    "  even-terminal config\n" +
    "  even-terminal config --reset\n" +
    "  even-terminal config <key> <value>\n" +
    "  Keys: provider, cwd, network, port, token, name, claudeUseSystemCli, claudeAllowedTools\n" +
    "  Network values: lan, tailscale, interface:<name>, expose:<provider>\n\n" +
    "Logging controls:\n" +
    "  --verbose controls raw diagnostics on stdout only.\n" +
    "  --log-level controls log-file detail only (debug by default; info omits raw payloads).\n\n" +
    "Default Claude SDK auto-approved tools:\n" +
    "  Read, Glob, Grep, ToolSearch, WebSearch, WebFetch, TaskOutput, ExitPlanMode,\n" +
    "  ListMcpResources, ReadMcpResource, TodoWrite, TaskUpdate\n" +
    "  Read-only Bash commands are also approved separately.\n\n" +
    "Shell completion (example usage):\n" +
    "  source <(even-terminal complete zsh)\n" +
    "  source <(even-terminal complete bash)\n" +
    "  even-terminal complete fish > ~/.config/fish/completions/even-terminal.fish\n" +
    "  even-terminal complete powershell >> $PROFILE"
  )
  .parse();

async function run(argv) {
  const configPath = resolveConfigPath(argv.config);
  let config = loadConfig(configPath, exposeProviderNames);
  if (!config) {
    config = await runSetupWizard(configPath);
  }

  applyResolvedEnvironment(resolveStartupEnvironment(config, argv, process.env));

  if (argv.verbose) process.env.VERBOSE = "1";
  if (argv["allow-cors"]) process.env.EVEN_ALLOW_CORS = "1";
  if (argv["use-original-claude"]) process.env.USE_ORIGINAL_CLAUDE = "1";

  const useSystemClaude = argv["claude-use-system-cli"] !== undefined
    ? argv["claude-use-system-cli"]
    : process.env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE
      ? null
      : config.claude.useSystemCli;
  if (useSystemClaude === false) {
    delete process.env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE;
  } else if (useSystemClaude === true) {
    const claudeExecutable = resolveSystemClaudeExecutable();
    if (!claudeExecutable) {
      throw new Error(
        "--claude-use-system-cli could not find an executable Claude CLI on PATH"
      );
    }
    process.env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE = claudeExecutable;
  }

  {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = argv["log-file"] || `even-terminal-${stamp}.log`;
    process.argv.push("--log-file", resolve(filename));
  }

  // Boot the server
  await import("../dist/index.js");
}

function applyResolvedEnvironment(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function runConfigCommand(argv) {
  rejectUnsupportedConfigOptions(rawArgs);
  const configPath = resolveConfigPath(argv.config);
  let config = null;
  if (argv.reset) {
    try { config = loadConfig(configPath, exposeProviderNames); } catch {}
  } else {
    config = loadConfig(configPath, exposeProviderNames);
  }

  if (argv.reset) {
    if (argv.key !== undefined || argv.value !== undefined) {
      throw new Error("--reset cannot be combined with a config key or value");
    }
    await runSetupWizard(configPath, config);
    return;
  }

  if (argv.key !== undefined || argv.value !== undefined) {
    if (argv.key === undefined || argv.value === undefined) {
      throw new Error("config updates require both a key and a value");
    }
    if (!config) {
      throw new Error(`Config ${configPath} does not exist. Run even-terminal config --reset first.`);
    }
    config = updateConfig(config, argv.key, argv.value, exposeProviderNames);
    saveConfig(configPath, config, exposeProviderNames);
    const shown = argv.key === "token" ? maskToken(config.token) : argv.value;
    console.log(`[config] Updated ${argv.key}: ${shown}`);
    return;
  }

  if (!config) {
    await runSetupWizard(configPath);
    return;
  }

  console.log(formatConfig(config, configPath));
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  await runConfigMenu(configPath, config);
}

function rejectUnsupportedConfigOptions(args) {
  const allowed = new Set(["--config", "--reset", "--help", "-h", "--version", "-v"]);
  for (const arg of args) {
    if (arg === "--") return;
    if (!arg.startsWith("-")) continue;
    const name = arg.split("=", 1)[0];
    if (!allowed.has(name)) {
      throw new Error(`${name} applies when starting the server and cannot be used with 'config'`);
    }
  }
}

async function runSetupWizard(configPath, existing = null) {
  requireInteractive("Setup requires an interactive terminal. Use even-terminal config <key> <value> for scripts.");
  const base = existing ?? createDefaultConfig();
  const tailscaleIp = detectTailscaleIp();

  console.log(`\nEven Terminal setup (${configPath})\n`);
  const provider = await choose(yellow("[1/4] Default agent"), [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "copilot", label: "GitHub Copilot" },
  ], Math.max(0, ["claude", "codex", "copilot"].indexOf(base.provider)));
  if (provider === "claude") {
    console.log("      Claude terminal/app synchronization is enabled by default; use --use-original-claude to opt out.\n");
  }

  const cwdInput = await ask(yellow("[2/4] Default project directory (~ expands to home)"), base.cwd);
  const cwd = resolveUserPath(cwdInput);
  console.log(`      Resolved path: ${cwd}\n`);
  const network = await promptNetwork(base.network, tailscaleIp);

  const token = existing?.token ?? generateToken();
  console.log(`${yellow("[4/4] Phone pairing token")}: ${existing ? "retained" : "generated"} (${maskToken(token)})`);
  console.log("      The server will print the pairing QR code after startup.\n");

  const config = saveConfig(configPath, {
    ...base,
    version: CONFIG_VERSION,
    provider,
    cwd,
    network,
    token,
  }, exposeProviderNames);
  console.log(`[config] Saved ${configPath}`);
  return config;
}

async function runConfigMenu(configPath, config) {
  const choice = await ask("\nEnter a number to change, or q to quit", "q");
  if (choice.toLowerCase() === "q") return;

  let next = config;
  switch (choice) {
    case "1": {
      const provider = await choose("Default agent", [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
        { value: "copilot", label: "GitHub Copilot" },
      ], Math.max(0, ["claude", "codex", "copilot"].indexOf(config.provider)));
      next = updateConfig(config, "provider", provider, exposeProviderNames);
      break;
    }
    case "2": {
      const cwd = await ask("Project directory (~ expands to home)", config.cwd);
      next = updateConfig(config, "cwd", cwd, exposeProviderNames);
      break;
    }
    case "3": {
      next = { ...config, network: await promptNetwork(config.network, detectTailscaleIp()) };
      break;
    }
    case "4": {
      const port = await ask("Port", String(config.port));
      next = updateConfig(config, "port", port, exposeProviderNames);
      break;
    }
    case "5": {
      const token = await ask("New token (leave blank to keep current)", "");
      if (!token) return;
      next = updateConfig(config, "token", token, exposeProviderNames);
      break;
    }
    case "6": {
      const name = await ask("Display name (use 'none' to clear)", config.name ?? "none");
      next = updateConfig(config, "name", name, exposeProviderNames);
      break;
    }
    case "7": {
      const enabled = await choose("Use system Claude CLI for SDK sessions", [
        { value: "off", label: "Off (SDK-bundled Claude)" },
        { value: "on", label: "On (system Claude)" },
      ], config.claude.useSystemCli ? 1 : 0);
      next = updateConfig(config, "claudeUseSystemCli", enabled, exposeProviderNames);
      break;
    }
    case "8": {
      const current = config.claude.allowedTools === undefined
        ? "default"
        : config.claude.allowedTools.length === 0
          ? "none"
          : config.claude.allowedTools.join(",");
      const tools = await ask("Claude allowed tools (CSV, none, or default)", current);
      next = updateConfig(config, "claudeAllowedTools", tools, exposeProviderNames);
      break;
    }
    default:
      throw new Error(`Invalid config menu choice "${choice}"`);
  }
  next = saveConfig(configPath, next, exposeProviderNames);
  console.log(`\n${formatConfig(next, configPath)}`);
}

async function promptNetwork(current, tailscaleIp) {
  console.log(`${yellow("[3/4] Phone connection")}\n`);
  if (!tailscaleIp) {
    console.log("      Tailscale is not ready. For a stable private connection, install and sign in on both laptop and phone:");
    console.log("      https://tailscale.com/download\n");
  }

  const options = [];
  if (tailscaleIp) {
    options.push({ value: "tailscale", label: `Tailscale (recommended) — ${tailscaleIp}` });
  }
  options.push(
    { value: "lan", label: "Local network (same Wi-Fi)" },
    { value: "interface", label: "Specific network interface" },
    { value: "expose", label: "Temporary tunnel (address may change after restart)" },
  );

  const defaultIndex = Math.max(0, options.findIndex((option) => option.value === current.mode));
  const kind = await choose("Connection method", options, defaultIndex);
  if (kind === "lan" || kind === "tailscale") return { mode: kind };
  if (kind === "interface") {
    const interfaces = listIpv4Interfaces();
    if (interfaces.length > 0) {
      const index = Math.max(0, interfaces.findIndex((item) => item.name === current.name));
      const selected = await choose("Network interface", interfaces.map((item) => ({
        value: item.name,
        label: `${item.name} — ${item.address}`,
      })), index);
      return { mode: "interface", name: selected };
    }
    const name = await ask("Network interface name", current.mode === "interface" ? current.name : "");
    return { mode: "interface", name };
  }

  const providerIndex = current.mode === "expose"
    ? Math.max(0, exposeProviderNames.indexOf(current.provider))
    : 0;
  const provider = await choose("Temporary tunnel provider", exposeProviderNames.map((name) => ({
    value: name,
    label: name,
  })), providerIndex);
  console.log("      Temporary tunnel URLs can change whenever the server restarts. Prefer Tailscale for regular use.\n");
  return { mode: "expose", provider };
}

function listIpv4Interfaces() {
  const result = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        result.push({ name, address: address.address });
        break;
      }
    }
  }
  return result;
}

function detectTailscaleIp() {
  const result = spawnSyncShim("tailscale", ["ip", "-4"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => isIP(line) === 4) ?? null;
}

function requireInteractive(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(message);
}

function ask(label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${label}${suffix}: `, (answer) => {
      rl.close();
      resolveAnswer(answer.trim() || defaultValue);
    });
  });
}

function yellow(text) {
  return process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR
    ? `\x1b[33m${text}\x1b[0m`
    : text;
}

function choose(label, options, defaultIndex = 0) {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || process.env.TERM === "dumb" || typeof input.setRawMode !== "function") {
    return chooseByNumber(label, options, defaultIndex);
  }

  console.log(`${label}:`);
  let selected = defaultIndex;
  let rendered = false;
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();

  const render = () => {
    if (rendered) output.write(`\r\x1b[${options.length + 1}A`);
    options.forEach((option, index) => {
      const line = index === selected
        ? `  \x1b[1m> ${option.label}\x1b[0m`
        : `    ${option.label}`;
      output.write(`\x1b[2K\r${line}\n`);
    });
    output.write("\x1b[2K\r\n\x1b[2K\r\x1b[2m    ↑/↓    Enter to confirm\x1b[0m");
    rendered = true;
  };

  return new Promise((resolveChoice, rejectChoice) => {
    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
    };
    const finish = (value) => {
      cleanup();
      output.write("\n\n");
      resolveChoice(value);
    };
    const onKeypress = (text, key) => {
      const typed = String(text ?? "").toLowerCase();
      if (key?.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        process.exit(130);
      }
      if (key?.name === "return" || key?.name === "enter") {
        finish(options[selected].value);
        return;
      }
      if (key?.name === "up" || typed === "k" || typed === "w") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key?.name === "down" || typed === "j" || typed === "s") {
        selected = (selected + 1) % options.length;
        render();
      }
    };
    input.on("keypress", onKeypress);
    try {
      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      render();
    } catch (err) {
      cleanup();
      rejectChoice(err);
    }
  });
}

async function chooseByNumber(label, options, defaultIndex) {
  console.log(`${label}:`);
  options.forEach((option, index) => {
    console.log(`  ${index === defaultIndex ? ">" : " "} ${index + 1}) ${option.label}`);
  });
  while (true) {
    const answer = await ask("Choice", String(defaultIndex + 1));
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      console.log("");
      return options[index].value;
    }
    console.log(`Enter a number between 1 and ${options.length}.`);
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function listLiveInstances() {
  let entries;
  try {
    entries = readdirSync(INSTANCE_DIR);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const live = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(INSTANCE_DIR, name);
    let info;
    try {
      info = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (typeof info.pid !== "number" || !isPidAlive(info.pid)) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    live.push(info);
  }
  live.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return live;
}

function formatAge(startedAt) {
  const secs = Math.max(0, Math.floor((Date.now() - (startedAt ?? Date.now())) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function promptChoice(instances, clientName = "codex") {
  return new Promise((resolveChoice, reject) => {
    process.stderr.write(`Multiple even-terminal servers are running. Pick one for ${clientName} to connect through:\n`);
    instances.forEach((inst, i) => {
      const codexPort = clientName === "codex" ? ` codex-port=${inst.codexAppServerPort}` : "";
      process.stderr.write(
        `  [${i + 1}] pid=${inst.pid} port=${inst.port}${codexPort} ` +
        `age=${formatAge(inst.startedAt)} cwd=${inst.cwd}\n`
      );
    });
    if (!process.stdin.isTTY) {
      reject(new Error(
        "stdin is not a TTY; cannot prompt. Stop all but one even-terminal server and retry."
      ));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Choice [1-${instances.length}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10);
      if (!Number.isFinite(idx) || idx < 1 || idx > instances.length) {
        reject(new Error(`Invalid choice "${answer.trim()}"`));
        return;
      }
      resolveChoice(instances[idx - 1]);
    });
  });
}

function postEnsureAppServer(instance, timeoutMs = 8000) {
  return new Promise((resolveReq, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: instance.port,
      path: "/api/codex/ensure-app-server",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${instance.token}`,
        "Content-Length": "0",
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolveReq(JSON.parse(body));
        } catch (err) {
          reject(new Error(`bad JSON from ensure-app-server: ${err.message}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("request timed out")); });
    req.on("error", reject);
    req.end();
  });
}

function probePort(port, timeoutMs = 500) {
  return new Promise((resolveProbe) => {
    const socket = netConnect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port, totalMs = 6000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function runCodex(extraArgs) {
  const cwd = process.cwd();
  const envPortRaw = process.env.CODEX_APP_SERVER_PORT;
  const envPort = envPortRaw ? parseInt(envPortRaw, 10) : null;

  let codexPort = envPort ?? 8765;

  if (!(await probePort(codexPort))) {
    let instances;
    try {
      instances = listLiveInstances();
    } catch (err) {
      console.error(`[codex] WARN: failed to read instance dir: ${err.message}`);
      instances = [];
    }

    if (envPort != null) {
      instances = instances.filter((i) => i.codexAppServerPort === envPort);
    }

    if (instances.length === 0) {
      console.error(
        "[codex] no running even-terminal server found to wake the codex app-server.\n" +
        "[codex] start one in another shell (e.g. `even-terminal`) and retry."
      );
      process.exit(1);
    }

    let chosen;
    if (instances.length === 1) {
      chosen = instances[0];
    } else {
      try {
        chosen = await promptChoice(instances, "codex");
      } catch (err) {
        console.error(`[codex] ${err.message}`);
        process.exit(1);
      }
    }

    try {
      const result = await postEnsureAppServer(chosen);
      if (!result.started) {
        console.error(
          `[codex] server reported codex app-server failed to start ` +
          `(see even-terminal logs on pid ${chosen.pid})`
        );
        process.exit(1);
      }
      codexPort = result.port ?? chosen.codexAppServerPort ?? codexPort;
    } catch (err) {
      console.error(
        `[codex] failed to signal even-terminal server pid=${chosen.pid} ` +
        `on port ${chosen.port}: ${err.message}`
      );
      process.exit(1);
    }

    if (!(await waitForPort(codexPort))) {
      console.error(`[codex] codex app-server did not become reachable on port ${codexPort} within 6s`);
      process.exit(1);
    }
  }

  const wsUrl = `ws://127.0.0.1:${codexPort}`;
  const args = hasCodexCwdArg(extraArgs)
    ? ["--remote", wsUrl, ...extraArgs]
    : ["--remote", wsUrl, "-C", cwd, ...extraArgs];
  const result = spawnSyncShim("codex", args, {
    stdio: "inherit",
    env: process.env,
    cwd,
  });
  if (result.error) {
    process.stderr.write(`even-terminal: failed to launch codex: ${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

async function runClaude(extraArgs) {
  const envPortRaw = process.env.EVEN_TERMINAL_PORT;
  const envPort = envPortRaw ? Number(envPortRaw) : null;
  if (envPort != null && (!Number.isInteger(envPort) || envPort < 1 || envPort > 65535)) {
    console.error(`[claude] invalid EVEN_TERMINAL_PORT "${envPortRaw}"`);
    process.exit(1);
  }

  let serverPort = envPort;
  if (serverPort == null) {
    let instances;
    try {
      instances = listLiveInstances();
    } catch (err) {
      console.error(`[claude] failed to discover running even-terminal servers: ${err.message}`);
      process.exit(1);
    }

    if (instances.length === 0) {
      console.error(
        "[claude] no running even-terminal server found.\n" +
        "[claude] start one in another shell (e.g. `even-terminal`) and retry."
      );
      process.exit(1);
    }

    let chosen;
    if (instances.length === 1) {
      chosen = instances[0];
    } else {
      try {
        chosen = await promptChoice(instances, "claude");
      } catch (err) {
        console.error(`[claude] ${err.message}`);
        process.exit(1);
      }
    }
    serverPort = chosen.port;
  }

  const wrapper = resolve(__dirname, "..", "src", "claude-sync", "wrapper.mjs");
  // The wrapper depends on node-pty's native binding, which is built against
  // Node's ABI. Bun loads the .node file but doesn't deliver onData events —
  // silently swallowing the entire TUI. So launch the wrapper under node
  // explicitly, falling back to whatever launched us if node isn't on PATH.
  const exec = resolveNodeExecutable() ?? process.execPath;
  const result = spawnSync(exec, [wrapper, ...extraArgs], {
    stdio: "inherit",
    env: { ...process.env, EVEN_TERMINAL_PORT: String(serverPort) },
    cwd: process.cwd(),
  });
  if (result.error) {
    process.stderr.write(`even-terminal: failed to launch claude wrapper (${exec}): ${result.error.message}\n`);
  }
  process.exit(result.status ?? 1);
}

function resolveNodeExecutable() {
  // Match `.../node` on POSIX and `...\node.exe` on Windows.
  if (/(^|[\\/])node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  const isWindows = process.platform === "win32";
  const probe = isWindows
    ? spawnSync("where", ["node"], { encoding: "utf8" })
    : spawnSync(process.env.SHELL || "sh", ["-c", "command -v node"], { encoding: "utf8" });
  const found = probe.stdout?.trim().split(/\r?\n/)[0];
  return found || null;
}

function resolveSystemClaudeExecutable() {
  if (process.platform === "win32") {
    const probe = spawnSync("where", ["claude"], { encoding: "utf8" });
    return probe.status === 0 ? "claude" : null;
  }
  const shell = process.env.SHELL || "sh";
  const probe = spawnSync(shell, ["-l", "-c", "command -v claude"], { encoding: "utf8" });
  return probe.stdout?.trim().split(/\r?\n/)[0] || null;
}

function hasCodexCwdArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-C" || arg === "--cd" || arg.startsWith("--cd=")) return true;
  }
  return false;
}
