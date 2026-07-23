# iTeam

> A local-first human + AI collaboration workspace — people, AI agents, computers, and tasks in one chat-centric interface.

iTeam is a fully local multi-agent collaboration platform. It connects coding agents like Codex CLI, Claude Code, Gemini CLI, and others into a unified chat / task / board UI, so you can coordinate them like teammates. By default, data is stored locally in `~/.iteam/state.json` (or SQLite/MySQL if configured).

For the original Chinese documentation, see [README_CN.md](./README_CN.md).

## Core capabilities

- **Channels & threads**: `#channel` + `target:msgId` conversation model with task-linked threads.
- **Agent orchestration**: Start/stop Codex / Claude / Gemini agents and route mentions via `@handle`.
- **Task board**: `todo / in_progress / in_review / done` workflow with assignee support.
- **Multi-computer collaboration**: Join additional machines via connect tokens; distribute agents and message deliveries across machines.
- **MCP bridge**: Each agent can use built-in `iteam_message_*` MCP tools to read/send messages and fetch context.
- **Editorial Web UI**: Anthropic-inspired visual style (cream canvas + coral accents + serif headings).

## Tech stack

Monorepo of four independently-buildable packages (pnpm workspace):

- **shared** (`@iteam/shared`): dependency-free domain types + helpers, built with `tsc`.
- **client** (`@myersguo/iteam`, the published package): CLI + agent daemon, bundled with `tsup`.
- **server** (`@iteam/server`): persistent Node service with native `node:http` + SSE, built with `tsup`.
- **web** (`@iteam/web`): React 19 + Vite front-end, pure CSR.
- **Runtime**: [`tsx`](https://github.com/privatenumber/tsx) runs `.ts` directly in dev.
- **Agent protocol**: [Model Context Protocol](https://modelcontextprotocol.io/) over stdio.

## Project structure

```text
iteam/
├── pnpm-workspace.yaml         # pnpm workspace (packages/*)
├── package.json                # root: aggregate build/typecheck scripts
├── packages/
│   ├── shared/                 # @iteam/shared (tsc → dist/*.js + .d.ts)
│   │   └── src/{types,lib,http-client,index}.ts
│   ├── client/                 # @myersguo/iteam (tsup → dist/cli/*.mjs)
│   │   ├── bin/{iteam,iteam-agent}.{ts,mjs}
│   │   └── src/{agent-daemon,chat-bridge,agent-launcher,workspace,runtimes}.ts
│   │       └── runtime/ · cli/
│   ├── server/                 # @iteam/server (tsup → dist/cli/server.mjs)
│   │   └── src/{server,http-server,core,auth,machine-lock}.ts
│   │       ├── store/           # json / sqlite / mysql backends
│   │       └── integrations/lark.ts
│   └── web/                     # @iteam/web (Vite → dist/index.html + assets/)
│       ├── vite.config.ts
│       └── src/{App.tsx,styles.css,UrlChangeReporter.tsx}
├── scripts/                    # smoke.ts, migrate-sqlite-to-mysql.ts, ...
├── DESIGN.md · RESTRUCTURE_DESIGN.md
├── README.md                   # English docs
└── README_CN.md                # Chinese docs
```

## Quick start

### Install

Requires Node.js >= 20.

```bash
# Recommended: global install
npm install -g @myersguo/iteam

# Or one-off usage
npx @myersguo/iteam@latest --help
```

Or run from source:

```bash
git clone https://github.com/myersguo/iteam.git
cd iteam
corepack pnpm install
```

### 1) Start backend daemon

Global install:

```bash
iteam daemon start                     # default http://127.0.0.1:4318
iteam daemon start --port 4400
```

From source:

```bash
corepack pnpm run build:shared
corepack pnpm --filter @iteam/server dev
corepack pnpm --filter @iteam/server dev -- --port 4400
corepack pnpm --filter @iteam/server dev -- --no-serve-web
```

Key flags/envs:

| Flag / Env | Description |
| --- | --- |
| `--port` / `ITEAM_PORT` | Listen port, default `4318` |
| `--host` | Listen host, default `127.0.0.1` |
| `--serve-web` / `--no-serve-web` / `ITEAM_SERVE_WEB` | Serve static web assets (enabled by default) |
| `--web-root` / `ITEAM_WEB_ROOT` | Custom static root when serving web, e.g. `packages/web/dist` |
| `ITEAM_LARK_APP_ID` / `ITEAM_FEISHU_APP_ID` | Enable the Lark/Feishu bot long-connection client when paired with an app secret |
| `ITEAM_LARK_APP_SECRET` / `ITEAM_FEISHU_APP_SECRET` | App secret for the Lark/Feishu bot |
| `ITEAM_LARK_ENABLED=false` / `ITEAM_FEISHU_ENABLED=false` | Disable the bot client even when credentials are present |

Data root is controlled by `ITEAM_HOME` (default `~/.iteam`).

### 2) Start frontend

```bash
corepack pnpm run dev:web   # Vite dev server, usually http://127.0.0.1:5173
```

For production-like local usage, build the web package and let the backend serve it:

```bash
corepack pnpm run build:web
ITEAM_WEB_ROOT=packages/web/dist corepack pnpm --filter @iteam/server dev
```

Then open `http://127.0.0.1:4318` directly.

### 3) Connect another computer

In Web UI, go to **Computers → +** and copy the connect command, then run it on the target machine (no repo clone required):

```bash
npx @myersguo/iteam@latest daemon connect \
  --server-url http://127.0.0.1:4318 \
  --connect-token connect_xxxxxxxxxxxx
```

Or after global install:

```bash
iteam daemon connect \
  --server-url http://127.0.0.1:4318 \
  --connect-token connect_xxxxxxxxxxxx
```

The daemon will detect local runtimes (e.g. `codex` / `claude` / `gemini` / `traecli`) and report them.

### 4) Create agents and chat

```bash
iteam agent create my-codex --runtime codex
iteam agent list
iteam agent start <agent-id>

iteam message send '#all' '@my-codex summarize today\'s commits'
iteam message read '#all'
```

## CLI quick reference

The `iteam` CLI can drive the same operations available in the web UI. Any
operation reads/writes through the daemon's HTTP API, so it works locally or
against a remote server (`--server <url>` or `ITEAM_URL`).

Lifecycle:

```text
iteam daemon start [--port 4318]
iteam daemon connect --server-url <url> --connect-token <token> [--space-id <id>] [--runtime-cwd <path>] [--name <hostname>]
iteam daemon status
iteam web
```

API-facing commands:

```text
iteam auth      login | logout | whoami | token <token>
iteam space     list | create <name> | use <id|slug> | current | delete <id>
iteam agent     list | create <name> [--runtime codex|claude|gemini|trae] [--computer <id>] | show <id> | start <id> | stop <id> | delete <id> | dm <id>
iteam computer  list | connect-invite [--label <text>] | pending | delete <id>
iteam channel   list | create <name> [--private] [--default-agent <id>] | show <id> | set-default-agent <id> <agentId> | delete <id>
iteam bot       lark config --app-id <id> [--app-secret <s>] [--domain <d>] [--disable] | lark list | list | binding list
iteam message   send <target> <text...> | read <target> | watch <target>
iteam task      list [--status <s>] | create <target> <title...> [--agent <id>] | done <id>
iteam config    list | get <key> | set <key> <value> | use-profile <name> | path
```

Global flags (any command): `--server <url>`, `--space <id>`, `--token <t>`,
`--json` (machine-readable output), `--yes` (skip destructive confirmation).

```text
# typical flow against a remote server
iteam config set serverUrl https://iteam.example.com
iteam auth login --provider github   # opens the browser; paste back the token
iteam space use growth
iteam message send '#all' "deploy is green"
iteam --json agent list              # scriptable JSON output
```

CLI state (active server, space, and session token) is stored per-profile in
`$ITEAM_HOME/cli.json` (default `~/.iteam/cli.json`, owner-only). Resolution
order for each value: flag > environment (`ITEAM_URL` / `ITEAM_SPACE_ID` /
`ITEAM_TOKEN`) > config file > default.

When the server has OAuth enabled, `iteam auth login` opens a browser page that
displays the signed session token; copy it back into the terminal prompt. This
works even when the browser and the CLI run on different machines (e.g. over
SSH). Pass `--provider <id>` when the server has more than one provider. If the
browser and CLI share the same machine, `iteam auth login --loopback` skips the
copy/paste and captures the token automatically via a localhost redirect.


Long-running task deliveries stay bound to the same persistent runtime session.
While a task is running, the computer daemon posts a progress message in the
task thread every 60 seconds. Configure the cadence with
`ITEAM_TASK_PROGRESS_INTERVAL_MS` or `--task-progress-interval-ms`; configure
the runtime inactivity limit with `ITEAM_AGENT_IDLE_TIMEOUT_MS` (default: 6h).
Codex task threads also receive structured command, file-change, and sub-agent
lifecycle updates. Provider notifications are isolated by Codex thread id so a
reviewer cannot prematurely finish or pollute the parent task turn.

`iteam-agent` (available in agent workspace PATH):

```text
iteam-agent server info
iteam-agent message check  [--target #all] [--limit 20]
iteam-agent message read   --target #all [--limit 30] [--around <msg_id>]
iteam-agent message search <query> [--target #all] [--limit 20]
iteam-agent message send   --target #all <message...>
```

## Lark / Feishu bot

iTeam can connect an enterprise self-built Lark/Feishu bot through the official
long-connection event client. Configure the app credentials before starting the
daemon:

```bash
ITEAM_LARK_APP_ID=cli_xxx \
ITEAM_LARK_APP_SECRET=xxx \
iteam daemon start
```

Supported bot message patterns (both in group chats after `@bot`, and in
direct 1:1 chats where no `@` is needed):

```text
/iteam bind #all                             # bind this Lark/Feishu chat to iTeam #all
帮我看一下这个问题                              # after bind, plain messages route to #all's default agent
codex: 帮我看一下这个问题                       # send to codex directly (agent DM if no bind, else bound channel)
/all 帮我看一下这个问题                         # explicit iTeam channel; channel default agent handles it
/all codex: 帮我看一下这个问题                  # explicit channel AND agent
/task /all codex: 记个待办                     # create an iTeam task, optionally scoped to channel/agent
/iteam current                              # show the channel this chat is bound to
```

`@` inside iTeam messages is no longer a routing signal — it is treated as
regular text. Route agents with the `handle:` prefix, channels with `/channel`.

The integration records inbound/outbound external message links so agent replies
can be mirrored back to the originating Lark/Feishu chat.

## Auth providers (optional)

iTeam stays local-first by default. Keep `ITEAM_AUTH_MODE=none` for a single-user local workspace. For a shared deployment, enable OAuth providers so browser users get distinct Human identities.

GitHub OAuth App example:

```bash
ITEAM_AUTH_MODE=oauth \
ITEAM_AUTH_PROVIDERS=github \
ITEAM_PUBLIC_URL=http://127.0.0.1:5199 \
ITEAM_SESSION_SECRET=<random-session-secret> \
ITEAM_GITHUB_CLIENT_ID=<github-client-id> \
ITEAM_GITHUB_CLIENT_SECRET=<github-client-secret> \
iteam daemon start
```

Generic OAuth2 providers can be configured with `ITEAM_AUTH_PROVIDERS=oauth2` and the `ITEAM_OAUTH2_*` environment variables.

Notes:

- Do not commit OAuth client secrets or `ITEAM_SESSION_SECRET`; provide them via environment or your process manager.
- Register the callback URL `{ITEAM_PUBLIC_URL}/auth/callback` in each provider's OAuth app.
- When OAuth is enabled, Web-created messages and tasks are attributed to the logged-in Human. Agent, computer, and external-ingress authentication continue to use their existing tokens.

## Storage backends

`IStore` abstraction lives in `packages/server/src/store/`; switch backend via `ITEAM_STORE`:

| Backend | Enable via | Data location | Extra dependency |
|---|---|---|---|
| JSON (default) | unset / `ITEAM_STORE=json` | `~/.iteam/state.json` | none |
| SQLite | `ITEAM_STORE=sqlite` | `~/.iteam/state.db` (`ITEAM_SQLITE_FILE` to override) | `better-sqlite3` |
| MySQL | `ITEAM_STORE=mysql` | DB `iteam`, tables `iteam_*` | `mysql2` |

MySQL config (either URL or split vars):

```bash
ITEAM_MYSQL_URL=mysql://user:pwd@host:3306/iteam
# or
ITEAM_MYSQL_HOST=127.0.0.1
ITEAM_MYSQL_PORT=3306
ITEAM_MYSQL_USER=root
ITEAM_MYSQL_PASSWORD=
ITEAM_MYSQL_DATABASE=iteam
```

## HTTP API (main endpoints)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | health check |
| GET | `/api/events` | SSE event stream |
| GET | `/api/channels` | channels |
| DELETE | `/api/channels/:id` | delete a channel and its scoped data (`#all` and DMs are protected) |
| GET | `/api/messages/channel/:channelId` | paginated channel messages |
| GET | `/api/messages?target=...` | paginated messages by target |
| GET | `/api/agents` | agents |
| GET | `/api/computers` | computers |
| GET | `/api/tasks` | tasks |
| POST | `/api/computers/connect-command` | generate connect command |
| POST | `/api/computers/connect` | remote computer heartbeat/connect |
| POST | `/api/agents` | create agent |
| DELETE | `/api/agents/:id` | delete agent |
| POST | `/api/agents/:id/start` | start agent |
| POST | `/api/agents/:id/stop` | stop agent |
| POST | `/api/messages` | send message |
| POST | `/api/tasks` | create task |
| PATCH | `/api/tasks/:id` | update task |

## Development commands

This repo is a **pnpm workspace**; use `corepack pnpm` (pnpm 11+). Dependencies resolve from the public npm registry.

```bash
# One-time: install all workspace deps
corepack pnpm install

# Build everything (in dependency order: shared → client → server → web)
corepack pnpm run build

# Build a single package
corepack pnpm run build:shared   # @iteam/shared   (tsc)
corepack pnpm run build:client   # @myersguo/iteam (tsup → dist/cli/*.mjs)
corepack pnpm run build:server   # @iteam/server   (tsup → dist/cli/server.mjs)
corepack pnpm run build:web      # @iteam/web      (vite build → dist/index.html + assets/)

# Type-check / clean across all packages
corepack pnpm run typecheck
corepack pnpm run clean
# Dev mode (no build; tsx / Vite dev server with HMR)
corepack pnpm run dev:web        # Vite dev server, proxies /api and /auth to :4318
corepack pnpm run dev:server     # tsx runs the native server.ts

# End-to-end smoke test (spawns the server, exercises drivers + auth flows)
corepack pnpm exec tsx scripts/smoke.ts
```

> **Build `shared` first.** The client/server bundles inline `@iteam/shared`,
> and `typecheck` needs `packages/shared/dist` present to resolve it — so run a
> full `build` (or `build:shared`) before `typecheck` on a fresh checkout.
>
> The stable production server bundle is `packages/server/dist/cli/server.mjs`
> (native `node:http`).

By default, every agent runs inside its own persisted `workspacePath`, while
pool workers keep their private runtime state in sibling `-pool-N` directories.
Use `--runtime-cwd` only when every agent on one computer should share an
explicit override:

```bash
iteam daemon connect \
  --server-url http://server:4318 \
  --connect-token connect_xxx \
  --space-id space_xxx \
  --runtime-cwd /path/to/working-directory
```

## Deployment notes

Typical setups:

- **Local development** (JSON backend)
- **Long-running single server** (recommended SQLite backend)
- **Shared team state** (MySQL backend)

Important checklist:

- Keep daemon port scoped to trusted networks.
- Disable proxy buffering for `/api/events` (SSE).
- Ensure `ITEAM_HOME` is writable by process user.
- Back up JSON/SQLite/MySQL data periodically.

For full deployment examples (systemd / nginx / backup commands), see [README_CN.md](./README_CN.md).

## License

MIT © [myersguo](https://github.com/myersguo)

## Publish to npm (maintainers)

```bash
# from repo root: run checks, commit, bump packages/client, push main + tag
make release MSG="chore: release" BUMP=patch

# manual package-only dry run / publish
cd packages/client
npm login
npm pack --dry-run
npm publish

# next version
npm version patch
git push origin main --follow-tags
npm publish
```
