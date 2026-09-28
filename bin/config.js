import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_PATH = join(homedir(), ".even-terminal", "config.json");
export const CONFIG_KEYS = Object.freeze([
  "provider",
  "cwd",
  "network",
  "port",
  "token",
  "name",
  "claudeUseSystemCli",
  "claudeAllowedTools",
]);

const TOP_LEVEL_KEYS = new Set([
  "version",
  "provider",
  "cwd",
  "network",
  "port",
  "token",
  "name",
  "claude",
]);
const CLAUDE_KEYS = new Set(["useSystemCli", "allowedTools"]);
const PROVIDERS = new Set(["claude", "claude-sync", "codex", "copilot"]);

export function resolveConfigPath(value) {
  if (!value) return DEFAULT_CONFIG_PATH;
  return resolveUserPath(value);
}

export function resolveUserPath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(value);
}

export function createDefaultConfig(cwd = process.cwd()) {
  return {
    version: CONFIG_VERSION,
    provider: "claude",
    cwd: resolveUserPath(cwd),
    network: { mode: "lan" },
    port: 3456,
    token: generateToken(),
    claude: { useSystemCli: false },
  };
}

export function generateToken() {
  return randomBytes(16).toString("hex");
}

export function loadConfig(path, exposeProviders) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`Cannot read config ${path}: ${err.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in config ${path}: ${err.message}`);
  }
  return parseConfig(raw, path, exposeProviders);
}

export function parseConfig(raw, source = "config", exposeProviders = []) {
  const object = parseObject(raw, source);
  rejectUnknownKeys(object, TOP_LEVEL_KEYS, source);

  if (object.version !== CONFIG_VERSION) {
    throw new Error(`${source}.version must be ${CONFIG_VERSION}`);
  }
  if (!PROVIDERS.has(object.provider)) {
    throw new Error(
      `${source}.provider must be one of: ${[...PROVIDERS].join(", ")}`,
    );
  }
  if (typeof object.cwd !== "string" || !object.cwd.trim()) {
    throw new Error(`${source}.cwd must be a non-empty path`);
  }
  if (!isAbsolute(object.cwd)) {
    throw new Error(`${source}.cwd must be an absolute path`);
  }

  const port = parsePort(object.port, `${source}.port`);
  const token = parseNonEmptyString(object.token, `${source}.token`);
  const network = parseNetwork(object.network, `${source}.network`, exposeProviders);

  let name;
  if (object.name !== undefined) {
    name = parseNonEmptyString(object.name, `${source}.name`);
  }

  const claudeObject = object.claude === undefined
    ? {}
    : parseObject(object.claude, `${source}.claude`);
  rejectUnknownKeys(claudeObject, CLAUDE_KEYS, `${source}.claude`);
  const useSystemCli = claudeObject.useSystemCli ?? false;
  if (typeof useSystemCli !== "boolean") {
    throw new Error(`${source}.claude.useSystemCli must be true or false`);
  }

  let allowedTools;
  if (claudeObject.allowedTools !== undefined) {
    if (!Array.isArray(claudeObject.allowedTools)) {
      throw new Error(`${source}.claude.allowedTools must be an array of tool names`);
    }
    allowedTools = parseToolNames(claudeObject.allowedTools, `${source}.claude.allowedTools`);
  }

  return {
    version: CONFIG_VERSION,
    provider: object.provider,
    cwd: object.cwd,
    network,
    port,
    token,
    ...(name ? { name } : {}),
    claude: {
      useSystemCli,
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    },
  };
}

export function saveConfig(path, config, exposeProviders) {
  const parsed = parseConfig(config, "config", exposeProviders);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const temp = join(parent, `.config-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try { unlinkSync(temp); } catch {}
    throw new Error(`Cannot write config ${path}: ${err.message}`);
  }
  return parsed;
}

export function updateConfig(config, key, value, exposeProviders) {
  const next = structuredClone(config);
  switch (key) {
    case "provider":
      next.provider = value;
      break;
    case "cwd":
      next.cwd = resolveUserPath(value);
      break;
    case "network":
      next.network = parseNetworkValue(value, exposeProviders);
      break;
    case "port":
      next.port = parsePortString(value, "port");
      break;
    case "token":
      next.token = parseNonEmptyString(value, "token");
      break;
    case "name":
      if (value === "none" || value === "default") delete next.name;
      else next.name = parseNonEmptyString(value, "name");
      break;
    case "claudeUseSystemCli":
      next.claude.useSystemCli = parseBoolean(value, key);
      break;
    case "claudeAllowedTools":
      if (value === "default") delete next.claude.allowedTools;
      else next.claude.allowedTools = parseClaudeAllowedTools(value);
      break;
    default:
      throw new Error(
        `Unknown config key "${key}". Supported keys: ${CONFIG_KEYS.join(", ")}`
      );
  }
  return parseConfig(next, "config", exposeProviders);
}

export function parseNetworkValue(value, exposeProviders) {
  if (value === "lan" || value === "tailscale") return { mode: value };
  if (value.startsWith("interface:")) {
    return { mode: "interface", name: parseNonEmptyString(value.slice(10), "interface name") };
  }
  if (value.startsWith("expose:")) {
    const provider = parseNonEmptyString(value.slice(7), "expose provider");
    if (!exposeProviders.includes(provider)) {
      throw new Error(`Unknown expose provider "${provider}". Supported providers: ${exposeProviders.join(", ")}`);
    }
    return { mode: "expose", provider };
  }
  throw new Error(
    `network must be lan, tailscale, interface:<name>, or expose:<provider>`
  );
}

export function parseClaudeAllowedTools(value) {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => name.length === 0)) {
    throw new Error("--claude-allowed-tools contains an empty tool name");
  }
  if (names.includes("none")) {
    if (names.length !== 1) {
      throw new Error("--claude-allowed-tools 'none' must be used alone");
    }
    return [];
  }
  return [...new Set(names)];
}

export function maskToken(token) {
  if (token.length <= 8) return "(set)";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export function formatConfig(config, path) {
  const network = config.network.mode === "interface"
    ? `interface:${config.network.name}`
    : config.network.mode === "expose"
      ? `expose:${config.network.provider}`
      : config.network.mode;
  const tools = config.claude.allowedTools === undefined
    ? "default"
    : config.claude.allowedTools.length === 0
      ? "none"
      : config.claude.allowedTools.join(",");
  return [
    `Even Terminal config (${path})`,
    "",
    `  1  Default agent         ${config.provider}`,
    `  2  Project directory     ${config.cwd}`,
    `  3  Network               ${network}`,
    `  4  Port                  ${config.port}`,
    `  5  Token                 ${maskToken(config.token)}`,
    `  6  Name                  ${config.name ?? "(default)"}`,
    `  7  Claude system CLI     ${config.claude.useSystemCli ? "on" : "off"}`,
    `  8  Claude allowed tools  ${tools}`,
  ].join("\n");
}

export function resolveStartupEnvironment(config, flags, inheritedEnv = {}) {
  const output = {};
  output.PORT = pickEnvironmentValue(flags.port, inheritedEnv.PORT, config.port, String);
  output.BRIDGE_TOKEN = pickEnvironmentValue(flags.token, inheritedEnv.BRIDGE_TOKEN, config.token);
  output.EVEN_TERMINAL_NAME = pickEnvironmentValue(flags.name, inheritedEnv.EVEN_TERMINAL_NAME, config.name);
  output.PROJECT_DIR = pickEnvironmentValue(
    flags.cwd,
    inheritedEnv.PROJECT_DIR,
    config.cwd,
    resolveUserPath,
  );
  output.DEFAULT_PROVIDER = pickEnvironmentValue(
    flags.provider,
    inheritedEnv.DEFAULT_PROVIDER,
    config.provider,
  );

  output.EVEN_HOST_MODE = inheritedEnv.EVEN_HOST_MODE;
  output.EVEN_HOST_INTERFACE = inheritedEnv.EVEN_HOST_INTERFACE;
  output.EVEN_TERMINAL_EXPOSE_PROVIDER = inheritedEnv.EVEN_TERMINAL_EXPOSE_PROVIDER;
  const exposeFlag = Array.isArray(flags.expose) ? flags.expose[0] : undefined;
  const hasNetworkFlag = Boolean(flags.lan || flags.tailscale || flags.interface || exposeFlag);

  if (hasNetworkFlag) {
    output.EVEN_HOST_MODE = undefined;
    output.EVEN_HOST_INTERFACE = undefined;
    output.EVEN_TERMINAL_EXPOSE_PROVIDER = undefined;
    if (flags.tailscale) {
      output.EVEN_HOST_MODE = "tailscale";
    } else if (flags.interface) {
      output.EVEN_HOST_MODE = "interface";
      output.EVEN_HOST_INTERFACE = flags.interface;
    }
    if (exposeFlag) output.EVEN_TERMINAL_EXPOSE_PROVIDER = exposeFlag;
  } else if (!output.EVEN_HOST_MODE && !output.EVEN_TERMINAL_EXPOSE_PROVIDER) {
    if (config.network.mode === "tailscale") {
      output.EVEN_HOST_MODE = "tailscale";
    } else if (config.network.mode === "interface") {
      output.EVEN_HOST_MODE = "interface";
      output.EVEN_HOST_INTERFACE = config.network.name;
    } else if (config.network.mode === "expose") {
      output.EVEN_TERMINAL_EXPOSE_PROVIDER = config.network.provider;
    }
  }

  if (flags["claude-allowed-tools"] !== undefined) {
    output.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS = JSON.stringify(
      parseClaudeAllowedTools(flags["claude-allowed-tools"]),
    );
  } else if (inheritedEnv.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS !== undefined) {
    output.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS = inheritedEnv.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS;
  } else if (config.claude.allowedTools !== undefined) {
    output.EVEN_TERMINAL_CLAUDE_ALLOWED_TOOLS = JSON.stringify(config.claude.allowedTools);
  }

  return output;
}

function parseNetwork(raw, label, exposeProviders) {
  const object = parseObject(raw, label);
  const mode = object.mode;
  if (mode === "lan" || mode === "tailscale") {
    rejectUnknownKeys(object, new Set(["mode"]), label);
    return { mode };
  }
  if (mode === "interface") {
    rejectUnknownKeys(object, new Set(["mode", "name"]), label);
    return { mode, name: parseNonEmptyString(object.name, `${label}.name`) };
  }
  if (mode === "expose") {
    rejectUnknownKeys(object, new Set(["mode", "provider"]), label);
    const provider = parseNonEmptyString(object.provider, `${label}.provider`);
    if (!exposeProviders.includes(provider)) {
      throw new Error(`${label}.provider must be one of: ${exposeProviders.join(", ")}`);
    }
    return { mode, provider };
  }
  throw new Error(`${label}.mode must be lan, tailscale, interface, or expose`);
}

function pickEnvironmentValue(flagValue, environmentValue, configValue, convert = String) {
  if (flagValue !== undefined) return convert(flagValue);
  if (environmentValue !== undefined) return environmentValue;
  if (configValue !== undefined) return convert(configValue);
  return undefined;
}

function parseObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
}

function parseNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parsePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function parsePortString(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return parsePort(Number(value), label);
}

function parseBoolean(value, label) {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`${label} must be on or off`);
}

function parseToolNames(value, label) {
  const parsed = value.map((name, index) => parseNonEmptyString(name, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must not contain duplicate tool names`);
  }
  return parsed;
}
