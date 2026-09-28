# Even Terminal with extensible CLI integrations

This repository is an independent implementation based on the JavaScript
published in
[`@evenrealities/even-terminal@0.10.4`](https://www.npmjs.com/package/@evenrealities/even-terminal).
It preserves the Even App and G2 bridge while establishing an extensible
interface for AI coding CLI integrations.

The main goals are:

- Add GitHub Copilot as a supported CLI integration.
- Define a typed contract that makes additional providers easier to add.
- Keep provider-specific SDK, session, permission, and event logic isolated.
- Preserve compatibility with the existing Claude, Claude Sync, and Codex
  integrations.
- Maintain a reproducible baseline for comparing future npm releases.

This is not the official Even Realities source repository. The original
TypeScript sources and tests were not included in the published npm artifact.
The upstream usage documentation is retained below where it remains applicable.

## Project status

| Area | Status |
|------|--------|
| npm 0.10.4 source reconstruction | Complete |
| Typed `CliIntegration` contract and registry | Complete |
| Claude, Claude Sync, and Codex compatibility | Preserved |
| GitHub Copilot integration | Implemented |
| Independent npm release | Not published |

## Integration architecture

CLI integrations implement `CliIntegration` from
`src/integrations/contracts.ts` and are registered through
`CliIntegrationRegistry`.

Each integration owns its provider-specific responsibilities:

- Session creation, listing, resumption, and history.
- Streaming text and tool events.
- Permission and user-input requests.
- Cancellation and status reporting.
- SDK or CLI lifecycle management.

Adding an integration requires a contract-compliant adapter and an explicit
registry entry. Shared HTTP routes interact only with the interface instead of
depending directly on a provider SDK.

## Build and run this implementation

```bash
git clone https://github.com/ViniciusSouza/even-terminal.git
cd even-terminal
npm install
npm test
npm install -g .
even-terminal --version
```

The editable runtime modules live under `src/` and build into `dist/`.
TypeScript compiles the reconstructed JavaScript in `allowJs` mode, allowing
new modules to use TypeScript while preserving the recovered ESM behavior.

## Docker

The repository includes a production image, a Compose configuration, and a
GitHub Actions workflow that publishes Linux `amd64` and `arm64` images to:

```text
ghcr.io/viniciussouza/even-terminal
```

Docker defaults to the `copilot` provider. Override `DEFAULT_PROVIDER` to select
another registered provider, although the initial container support and mounts
are designed and validated for GitHub Copilot.

Copy the example environment file:

```bash
cp .env.docker.example .env.docker
```

Set these required values in `.env.docker`:

| Variable | Purpose |
|----------|---------|
| `BRIDGE_TOKEN` | Persistent secret used by the Even app |
| `EVEN_ADVERTISE_HOST` | Laptop LAN address or DNS name reachable by the phone |
| `PROJECT_PATH` | Host project mounted at `/workspace` |
| `COPILOT_GITHUB_TOKEN_FILE` | Local file containing a GitHub token |

Authenticate with GitHub CLI on the host, then create the Docker secret file.
The `.secrets/` directory is excluded from Git and the Docker build context.

Linux and macOS:

```bash
mkdir -p .secrets
gh auth token > .secrets/copilot-github-token
chmod 600 .secrets/copilot-github-token
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force .secrets | Out-Null
gh auth token | Set-Content -NoNewline .secrets\copilot-github-token
```

Build and start locally:

```bash
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker logs -f even-terminal
```

Use the published image without building:

```bash
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
```

Stop the service:

```bash
docker compose --env-file .env.docker down
```

The container listens on all container interfaces while generated connection
URLs use `EVEN_ADVERTISE_HOST`. This separation prevents the QR code from
advertising an internal Docker address. The container runs as a non-root user,
the mounted project remains writable so Copilot can apply approved changes,
and a named volume preserves Copilot session data across container replacement.

For direct `docker run` usage, authentication can also be supplied through
`COPILOT_GITHUB_TOKEN`. Prefer `COPILOT_GITHUB_TOKEN_FILE` or a Docker secret
when possible because environment variables are visible in container metadata.

## Official npm package

To use the official published package instead of this implementation:

```bash
npm install -g @evenrealities/even-terminal
```

> Building glasses-native apps instead of mirroring your laptop? See
> [@evenrealities/even_hub_sdk](https://www.npmjs.com/package/@evenrealities/even_hub_sdk).

## Requirements

- **Node.js 20.19+**. Check with `node --version`.
- An **Even Realities G2** and **R1 ring**, paired through the Even app.
- Optional: Tailscale on the laptop and phone for a stable private connection.

---

## Quick Start

```bash
even-terminal
```

On the first run, a four-step setup wizard covers the default agent, project
directory, and phone connection, then generates a persistent pairing token. It
stores the result in `~/.even-terminal/config.json`, then starts the foreground
server. Later runs reuse that configuration.

Use the arrow keys, `k`/`j`, or `w`/`s` to move through wizard choices, then
press Enter to confirm. Project-directory input accepts `~` for the home
directory and prints the resolved absolute path after confirmation.

The configured project directory becomes the working directory for new
sessions when the client omits `cwd`. Session listing remains unfiltered unless
the client explicitly supplies a `cwd` filter.

The default server port is `3456`.

Useful startup options:

```bash
even-terminal --cwd /path/to/project
even-terminal --port 8080
even-terminal --token mytoken123
even-terminal --name my-laptop
even-terminal --provider codex
even-terminal --provider copilot
even-terminal --lan
even-terminal --allow-cors
even-terminal --claude-use-system-cli
even-terminal --claude-allowed-tools Read,Glob,Grep,ToolSearch
even-terminal --config ~/.even-terminal/work.json
even-terminal --expose pinggy
even-terminal --expose bore
even-terminal --expose ngrok
```

---

## How it works

even-terminal runs a local HTTP server on `:3456` (configurable through setup,
`even-terminal config`, or `--port`), connects to your AI agent (Claude Code, Codex, or GitHub Copilot), captures its
streaming output, renders it onto the
G2's 576×288 canvas, and translates R1 ring gestures back into keyboard events
for the agent.

The Even app connects to your laptop over your chosen transport. By default the server listens on all interfaces and advertises your detected LAN address (same Wi-Fi). Pass `--tailscale` to bind external access to your Tailscale IPv4 address (stable across networks, end-to-end WireGuard), or `-i <interface>` to bind external access to a specific network interface. Both modes retain a loopback listener for the local Claude/Codex CLI integrations. Use `--expose pinggy` / `--expose bore` / `--expose ngrok` to open a temporary public tunnel.

```
                       ┌──────────────────┐
                       │   your laptop    │
[ claude / codex / copilot ] ─│ even-terminal │
                       │   :3456          │
                       └────────┬─────────┘
                                │
                ┌───────────────┴───────────────┐
                │   transport (pick one)        │
                │   default: LAN (same Wi-Fi)   │
                │   --tailscale                 │
                │   --expose pinggy             │
                │   --expose bore               │
                │   --expose ngrok              │
                └───────────────┬───────────────┘
                                │
                       ┌────────┴─────────┐
                       │     Even app     │
                       └──┬────────────┬──┘
                       (display)     (input)
                       BLE ↓          ↑ BLE
                     ┌────┴────┐  ┌────┴────┐
                     │   G2    │  │   R1    │
                     │ 576×288 │  │  ring   │
                     └─────────┘  └─────────┘
```

The agent runs locally on *your* laptop, using either a bundled or system
executable as described below. even-terminal is a renderer + input bridge.

---

## CLI

```text
even-terminal [command] [options]

Commands:
  even-terminal start
  even-terminal config [key] [value]
  even-terminal complete <shell>
  even-terminal copilot

Local network options:
  --lan
  --tailscale
  -i, --interface, --if <name>

Quick public expose options:
  --expose <provider>   Quick public expose provider (`pinggy`, `bore`, `ngrok`)

Options:
  -p, --port <n>
  -t, --token <str>
  -n, --name <str>
  -d, --cwd <path>
  --provider <name>   claude, claude-sync, codex, copilot (default: claude)
  --config <path>     Use another persistent config file
  --allow-cors        Allow cross-origin browser requests
  --use-original-claude  Use the original Claude SDK provider without terminal/app synchronization
  --claude-use-system-cli  Use the system Claude CLI for SDK sessions
  --claude-allowed-tools <csv|none>  Replace Claude SDK auto-approved tools
  --log-file <path>  Write logs to a file
  --log-level <debug|info>  Control log-file detail only (default: debug)
  --verbose  Print raw diagnostics to stdout only; does not change log files
  -h, --help
  -v, --version

Examples:
  even-terminal
  even-terminal -p 8080
  even-terminal -t mytoken123
  even-terminal --expose pinggy
  even-terminal --expose ngrok
```

## Setup and persistent configuration

The first-run wizard writes a versioned configuration file with permissions
`0600` on macOS and Linux. The pairing token remains stable across restarts.
The wizard stores `claude`, `codex`, or `copilot` as the default provider.
Claude uses Claude Sync by default; pass `--use-original-claude` to opt out.

Run the interactive config menu at any time:

```bash
even-terminal config
even-terminal config --reset
```

Scripts can update one parsed value without opening the menu:

```bash
even-terminal config provider codex
even-terminal config cwd /path/to/project
even-terminal config token 'new-token'
even-terminal config network tailscale
even-terminal config network interface:en0
even-terminal config network expose:pinggy
even-terminal config port 4567
even-terminal config claudeUseSystemCli on
even-terminal config claudeAllowedTools Read,Glob,Grep,ToolSearch
even-terminal config claudeAllowedTools default
```

`config --reset` reruns the wizard while retaining the existing pairing token.
To rotate it, run `even-terminal config token '<new-token>'`. The next server
start prints a new QR code; use it to pair the client again.

Use `--config <path>` for another profile. Relative paths resolve from the
current directory; `~/...` paths resolve from the home directory.

Startup values follow this precedence:

```text
CLI flag > environment variable > config file > built-in default
```

Flags and environment variables affect the current process without rewriting
the selected config file. Invalid JSON, unknown fields, unsupported providers,
and malformed network values fail before the server starts.

Cross-origin browser requests are disabled by default. Native Flutter clients
and same-origin web clients are unaffected; pass `--allow-cors` only when a
different browser origin must call the server.

The setup wizard does not install or start a background service. Start the
foreground server yourself with `even-terminal`; stop it with `Ctrl+C`.
`even-terminal claude` and `even-terminal codex` connect to an already-running
server and report an error when none is available.

## Logging

Log files use `debug` detail by default, preserving raw SDK, app-server, SSE,
permission, and question payloads. Opt into a smaller file with:

```bash
even-terminal --log-level info
```

`info` retains server and provider lifecycle events, HTTP and prompt summaries,
session state, usage, retries, warnings, and errors. `--verbose` is independent:
it controls raw diagnostics on stdout only. For example, this keeps verbose
stdout while writing an `info` log file:

```bash
even-terminal --verbose --log-level info
```

Quick public expose helpers are intended for simple temporary sharing, not long-term use.
For stable setups, prefer a proper network path such as Tailscale or a production tunnel configuration.

Current quick expose providers:

### pinggy

No install required — uses your system's SSH client. Just pass `--expose pinggy`.

Behind the scenes:

```bash
ssh -p 443 -R0:localhost:<port> a.pinggy.io
```

Pinggy is a hosted SSH-tunnel service; the public URL appears in your terminal once the tunnel is up.

### bore

Self-hostable, written in Rust. GitHub: [ekzhang/bore](https://github.com/ekzhang/bore).

Install:

- **macOS:** `brew install bore-cli` *(or)* `cargo install bore-cli`
- **Linux:** `cargo install bore-cli` *(or)* download a prebuilt binary from [releases](https://github.com/ekzhang/bore/releases) and put `bore` on your `$PATH`
- **Windows:** download `bore-vX.Y.Z-x86_64-pc-windows-msvc.zip` from [releases](https://github.com/ekzhang/bore/releases), extract `bore.exe`, add its folder to your `PATH`

Verify with `bore --version`. Then `--expose bore` runs:

```bash
bore local <port> --to bore.pub
```

### ngrok

Hosted tunnel service, free tier available. Site: [ngrok.com](https://ngrok.com).

Install:

- **macOS:** `brew install ngrok/ngrok/ngrok`
- **Linux:** see the apt/yum repos at [ngrok.com/download](https://ngrok.com/download) — or download the tarball, extract, and put `ngrok` on your `$PATH`
- **Windows:** download the zip from [ngrok.com/download](https://ngrok.com/download), extract `ngrok.exe`, add its folder to your `PATH`

One-time setup — sign up at [ngrok.com](https://ngrok.com), copy your authtoken from the dashboard, then:

```bash
ngrok config add-authtoken <your-token>
```

Verify with `ngrok --version`. Then `--expose ngrok` runs:

```bash
ngrok http <port>
```

Shell completion (example usage):

```text
even-terminal complete zsh
even-terminal complete bash
even-terminal complete fish
even-terminal complete powershell
```

Each form prints the completion script for that shell.


## Flow

1. Start the foreground server with `even-terminal`. On first run, finish the setup wizard; the server then prints a connection URL, the persistent token, and a QR code.
2. Open the Even app on your phone and scan the QR code — or paste the URL and token manually if scanning isn't convenient.
3. Your G2 glasses and R1 ring connect via BLE through the Even app. The agent's output streams onto the glasses, and ring gestures route back to the agent as keyboard events.


## Providers

Even Terminal can run all supported providers concurrently. `--provider <name>`
selects the default provider; clients may still choose another provider for each
session.

| Provider      | Purpose                                      | Status       |
|---------------|----------------------------------------------|--------------|
| `claude`      | Claude sessions managed through Agent SDK    | Stable       |
| `claude-sync` | Shared Claude sessions across CLI and app    | Experimental |
| `codex`       | Real-time Codex sessions through app-server  | Stable       |
| `copilot`     | GitHub Copilot sessions through Copilot SDK  | Experimental |

Install and authenticate the corresponding system CLI before using the Claude
or Codex wrapper commands. The Copilot SDK includes a platform runtime and uses
the locally logged-in Copilot user by default.

### Claude

Sessions started from the Even app normally use the `claude` provider through
Claude Agent SDK.

To use the familiar Claude terminal interface while allowing the Even app to
join the same session, run:

```bash
even-terminal claude
even-terminal claude --resume <session-id>
```

Normal Claude arguments pass through to the system `claude` CLI. The command
automatically discovers a running Even Terminal server and prompts for one when
multiple instances are available.

#### Experimental terminal and app synchronization

The `claude-sync` provider remains experimental. It relies on a compatibility
layer around the Claude CLI rather than a native shared-session protocol.
Expect occasional edge cases around CLI input, session resume, output timing,
permissions, and compatibility with future Claude CLI releases.

Given the integration surface Anthropic has chosen to expose, this remains
about the best shared-session experience Even Terminal can provide.

Claude Sync runs under the `claude` provider name by default. Start the server:

```bash
even-terminal
```

Then open Claude in another terminal:

```bash
even-terminal claude
```

To use the original Claude SDK provider without terminal/app synchronization,
start the server with `even-terminal --use-original-claude`. The explicit
`claude-sync` provider remains available.

#### Selecting a server port

The Claude wrapper normally discovers the server automatically. To connect it
to a specific Even Terminal port:

```bash
even-terminal --port 4567
env EVEN_TERMINAL_PORT=4567 even-terminal claude
env EVEN_TERMINAL_PORT=4567 even-terminal claude --resume <session-id>
```

PowerShell:

```powershell
$env:EVEN_TERMINAL_PORT = "4567"
even-terminal claude --resume <session-id>
```

#### Claude executable compatibility

Agent SDK sessions use the SDK-bundled Claude executable by default. If that
version behaves differently from the system installation, start Even Terminal
with:

```bash
even-terminal --claude-use-system-cli
```

This compatibility option may help with version-specific problems, though it
cannot guarantee identical behavior. `even-terminal claude` always launches
the system `claude` CLI.

#### Claude automatic tool approval

Even Terminal's default list appears in `even-terminal --help`:

```text
Read, Glob, Grep, ToolSearch, WebSearch, WebFetch, TaskOutput, ExitPlanMode,
ListMcpResources, ReadMcpResource, TodoWrite, TaskUpdate
```

`WebSearch` and `WebFetch` can access the network without an app confirmation.
To replace the list, pass comma-separated, case-sensitive tool names; use
`none` to clear the entries supplied by Even Terminal:

```bash
even-terminal --claude-allowed-tools Read,Glob,Grep,ToolSearch
even-terminal --claude-allowed-tools none
```

Empty names and `none` mixed with other names are rejected. Unknown names are
accepted because Claude can load custom tools from user/project MCP settings
and plugins; fully qualified MCP names normally look like
`mcp__<server>__<tool>`. Native allow rules in Claude user or project settings
may approve additional tools independently of this option.

### Codex

Even Terminal integrates with Codex through its native app-server protocol.
The app-server runs locally and starts lazily when a Codex session first needs
it.

```bash
even-terminal codex
```

This command discovers a running Even Terminal instance and launches the system
Codex CLI with `codex --remote`, connecting it to the same app-server used by
the Even app. Normal Codex arguments pass through to the CLI.

When the terminal and app use the same Codex thread, prompts entered from either
side and streamed responses appear on both sides in real time. Codex provides
an actual multi-client shared-session protocol, giving Even Terminal a direct
and considerably more reliable synchronization path. Claude currently offers
no equivalent interface, hence the experimental compatibility layer described
above.

In practice, Codex synchronization provides the stronger experience by design:
native real-time events, direct bidirectional input, and fewer version-sensitive
edge cases.

#### Selecting the Codex app-server port

The Codex app-server uses port `8765` by default. To use another port, start the
server and Codex CLI with `CODEX_APP_SERVER_PORT`:

```bash
env CODEX_APP_SERVER_PORT=8766 even-terminal
env CODEX_APP_SERVER_PORT=8766 even-terminal codex
```

PowerShell:

```powershell
$env:CODEX_APP_SERVER_PORT = "8766"
even-terminal
even-terminal codex
```

This port belongs to the local Codex app-server. The main Even Terminal HTTP
port remains controlled by `--port`.

### GitHub Copilot

Start the server with GitHub Copilot selected:

```bash
even-terminal copilot
even-terminal --provider copilot
```

The Copilot integration uses `@github/copilot-sdk` and its bundled platform
runtime. It reuses authentication from the local Copilot environment and does
not read or forward a GitHub token directly. If authentication is unavailable,
install the GitHub Copilot CLI, sign in, and verify the installation:

```bash
copilot --version
```

Set `COPILOT_CLI_PATH` to use a specific Copilot CLI executable instead of the
runtime bundled with the SDK. Set `COPILOT_MODEL` to request a particular model:

```powershell
$env:COPILOT_CLI_PATH = "C:\path\to\copilot.exe"
$env:COPILOT_MODEL = "gpt-5"
even-terminal copilot
```

Copilot sessions persist through the SDK session store and can be resumed from
the Even app. Text, tool activity, usage, and user questions stream through the
same provider-independent bridge used by the other integrations. Reasoning
content and sub-agent events are not exposed.

Tool operations require an explicit response in the Even app. The current
integration offers **Allow once** and **Deny**. It does not provide blanket or
session-wide approval. Unlike the Claude and Codex commands, `even-terminal
copilot` starts the server with Copilot selected; it does not open a separate
interactive Copilot terminal.

---

## Common problems

| **Symptom**                                               | **Cause**                                               | **Fix**                                                                                  |
|-----------------------------------------------------------|---------------------------------------------------------|------------------------------------------------------------------------------------------|
| Phone app shows "Server unreachable"                      | Laptop and phone on different transports                | Match: both on Tailscale (`--tailscale`) or both on the same Wi-Fi                       |
| `EADDRINUSE :3456`                                        | Another even-terminal already running                   | `lsof -i :3456` → kill old one, or pass `--port <other>`                                 |
| `command not found: claude` or `codex`                   | Agent binary not on `$PATH`                             | Install per the Providers section; verify with `which claude` or `which codex`            |
| Copilot reports an authentication or runtime error       | No local Copilot login, or an invalid CLI override      | Sign in with Copilot CLI; verify `copilot --version`; check or unset `COPILOT_CLI_PATH`    |
| Claude SDK sessions behave differently from `claude`    | The SDK-bundled and system Claude versions may differ   | Try `--claude-use-system-cli`; this compatibility workaround is not guaranteed            |
| `--expose pinggy` hangs                                   | Pinggy edge timing out                                  | Switch to `--expose bore`, `--expose ngrok`, or Tailscale                                |
| Phone can no longer authenticate after manually changing the token | The app still has the previous token                    | Scan the new QR code or restore the previous token with `even-terminal config token <value>` |
| Output truncated mid-stream                               | Agent printed something the 576×288 layout can't render | Re-run with `--verbose --log-file ./debug.log` and open an issue with the offending line |

For anything else: `even-terminal --verbose --log-file ./debug.log`, reproduce, attach the log to an email to software@evenrealities.com .

---

## Upstream changelog

The entries below were retained from the `@evenrealities/even-terminal`
0.10.4 npm artifact. Changes specific to this repository are tracked through
its Git history and releases.

### 0.10.3

- make Claude Sync the default implementation of `claude`
- replace `--claude-sync-as-claude` with `--use-original-claude` to opt out

### 0.10.2

- disable Pinggy's rich terminal UI to prevent interference with startup text and QR codes
- select a non-loopback private IPv4 address for LAN mode without filtering interface names
- bind LAN access to the selected address while preserving IPv4 loopback; use loopback alone for tunnel-only mode or when no LAN address qualifies
- reject combinations of `--lan`, `--tailscale`, and `--expose` before startup without changing saved configuration

### 0.10.1

- preserve loopback access for local Claude/Codex integrations when binding to
  a restricted external address
- retain the original working directory when resuming Claude sessions after a
  server restart
- make explicit network flags clear conflicting inherited network settings

### 0.10.0

- Setup and persistent configuration
  - add a keyboard-driven first-run wizard for the default agent, project
    directory, network, and pairing token
  - store versioned profiles and stable pairing tokens with owner-only file
    permissions on macOS and Linux
  - add interactive and non-interactive `config` commands, alternate profiles
    through `--config`, and explicit CLI > environment > config > default
    precedence
  - persist network selection, including the new `--lan` mode
  - use the configured project directory for new sessions while resumed
    sessions retain their original working directory
- Claude and Claude Sync
  - use the Claude Agent SDK as the shared backend for `claude` and headless
    `claude-sync` sessions, while preserving wrapped interactive CLI sessions
  - upgrade Claude Agent SDK to `0.3.231` for compatibility with newer Claude
    CLI session transcripts
  - mark Claude Sync as experimental and add `--claude-sync-as-claude` for
    clients that cannot select it directly
  - add `--claude-use-system-cli` as an SDK/CLI compatibility fallback
  - expose and configure the default automatically approved tool list, while
    accepting custom and MCP tool names
- CLI, security, and diagnostics
  - accept documented dashed option names without generating camelCase aliases
  - synchronize shell completion for wrapper commands, configuration keys and
    values, aliases, and newly added options
  - document wrapper discovery and explicit Claude/Codex port selection
  - separate stdout verbosity from log-file detail with `--verbose` and
    `--log-level`
  - bind Tailscale/interface modes to the selected address, require explicit
    `--allow-cors` for permissive CORS, and redact query-string token values
    while preserving other request parameters

### 0.9.0

- Internal release; not published publicly.

### 0.8.1

- optimize codex session history performance for large session (windows)
- add `--expose ngrok` support (need to sign in elsewhere first)

### 0.8.0

- codex now only starts a background process when necessary

### 0.7.9

- add debug timing for codex history api
- fix middle deny behavior in multiple permission requests

### 0.7.8

- add update check api

### 0.7.7

- improve codex support with `even-terminal codex` wrapper which can sync
messages between codex cli and glasses
- internal refactoring

---

## License

The upstream README distributed with `@evenrealities/even-terminal@0.10.4`
declares the project as MIT licensed. This repository retains that declaration
for the reconstructed upstream code.
