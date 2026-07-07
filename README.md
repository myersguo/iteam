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

- **Backend**: Node.js HTTP server + SSE, fully typed with TypeScript.
- **Frontend**: React 19 + TypeScript + Vite.
- **Runtime**: [`tsx`](https://github.com/privatenumber/tsx) runs `.ts` directly.
- **Agent protocol**: [Model Context Protocol](https://modelcontextprotocol.io/) over stdio.

## Project structure

```text
iteam/
├── bin/                    # CLI entrypoints
│   ├── iteam.mjs
│   ├── iteam.ts
│   ├── iteam-agent.mjs
│   └── iteam-agent.ts
├── src/                    # backend TypeScript source
│   ├── server.ts
│   ├── agent-daemon.ts
│   ├── chat-bridge.ts
│   ├── runtime.ts
│   ├── runtimes.ts
│   ├── agent-launcher.ts
│   ├── workspace.ts
│   ├── http-client.ts
│   ├── types.ts
│   └── store/
├── web/src/
│   ├── App.tsx
│   └── styles.css
├── scripts/
│   └── smoke.ts
├── DESIGN.md
├── README.md               # English docs
├── README_CN.md            # Chinese docs
└── package.json
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
npm install
```

### 1) Start backend daemon

Global install:

```bash
iteam daemon start                     # default http://127.0.0.1:4318
iteam daemon start --port 4400
```

From source:

```bash
npm run server
npm run server -- --port 4400
npm run server -- --no-serve-web
```

Key flags/envs:

| Flag / Env | Description |
| --- | --- |
| `--port` / `ITEAM_PORT` | Listen port, default `4318` |
| `--host` | Listen host, default `127.0.0.1` |
| `--serve-web` / `--no-serve-web` / `ITEAM_SERVE_WEB` | Serve `dist/` static assets (enabled by default) |
| `--web-root` / `ITEAM_WEB_ROOT` | Custom static root when serving web |
| `ITEAM_LARK_APP_ID` / `ITEAM_FEISHU_APP_ID` | Enable the Lark/Feishu bot long-connection client when paired with an app secret |
| `ITEAM_LARK_APP_SECRET` / `ITEAM_FEISHU_APP_SECRET` | App secret for the Lark/Feishu bot |
| `ITEAM_LARK_ENABLED=false` / `ITEAM_FEISHU_ENABLED=false` | Disable the bot client even when credentials are present |

Data root is controlled by `ITEAM_HOME` (default `~/.iteam`).

### 2) Start frontend

```bash
npm run dev                 # http://127.0.0.1:5173
```

If backend serves static web assets, open `http://127.0.0.1:4318` directly.

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

```text
iteam daemon start [--port 4318]
iteam daemon connect --server-url <url> --connect-token <token> [--name <hostname>]
iteam daemon status
iteam web

iteam computer list

iteam agent create <name> [--runtime codex|claude|gemini]
iteam agent list
iteam agent start <agent-id>
iteam agent stop  <agent-id>
iteam agent delete <agent-id>

iteam channel list
iteam message send  <#channel> <message...>
iteam message read  <#channel>
iteam task create   <#channel> <title...> [--agent <agent-id>]
iteam task list
```

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

## Storage backends

`IStore` abstraction lives in `src/store/`; switch backend via `ITEAM_STORE`:

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

```bash
npm run dev          # frontend (Vite)
npm run server       # backend daemon
npm run agent-daemon # client-side daemon bridge
npm run cli -- ...   # iteam CLI via tsx
npm run typecheck    # TypeScript type checking
npm run build        # build web + CLI bundles
npm run smoke        # end-to-end smoke test
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
npm login
npm pack --dry-run
npm publish

# next version
npm version patch
git push --follow-tags
npm publish
```
