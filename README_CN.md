# iTeam

> 本地优先的人机协作工作区——把人、AI Agent、计算机和任务装进同一个聊天室。

iTeam 是一个完全跑在本地的多 Agent 协作平台。它把 Codex CLI、Claude Code、Gemini CLI 等编码 Agent 接入一个统一的聊天 / 任务 / 看板界面，让你像和同事协作一样指挥它们。默认数据保存在本地 `~/.iteam/state.db`（SQLite），也可切换到 JSON 或 MySQL 后端。

## 核心能力

- **频道与线程**：基于 `#channel` 与 `target:msgId` 形态的会话模型，支持任务关联线程
- **Agent 编排**：动态启停 Codex / Claude / Gemini Agent，按 `@handle` 转发消息
- **任务看板**：todo / in_progress / in_review / done 四态看板，支持指派 Agent
- **多机协同**：通过 connect-token 把额外计算机加入工作区，跨机分发 Agent 与消息投递
- **MCP 桥接**：每个 Agent 自带 `iteam_message_*` MCP 工具，可在 runtime 内主动读消息、发消息、查上下文
- **编辑式 Web UI**：参考 Anthropic 设计语言，奶油色画布 + 珊瑚色强调 + 衬线标题

## 技术栈

pnpm workspace 单仓,四个可独立构建的包:

- **shared**（`@iteam/shared`）：零依赖领域类型 + 工具函数,`tsc` 构建
- **client**（`@myersguo/iteam`,即发布包）：CLI + agent daemon,`tsup` 打包
- **server**（`@iteam/server`）：常驻 Node 服务 —— 原生 `node:http` + SSE，`tsup` 构建
- **web**（`@iteam/web`）：React 19 + Vite 前端，纯 CSR
- 运行时：[`tsx`](https://github.com/privatenumber/tsx) 开发态直接执行 `.ts`
- Agent 通信：[Model Context Protocol](https://modelcontextprotocol.io/) Stdio Server

## 目录结构

```
iteam/
├── pnpm-workspace.yaml         # pnpm workspace（packages/*）
├── package.json                # 根：聚合 build / typecheck 脚本
├── packages/
│   ├── shared/                 # @iteam/shared（tsc → dist/*.js + .d.ts）
│   │   └── src/{types,lib,http-client,index}.ts   # 领域类型 / 工具 / HTTP 封装
│   ├── client/                 # @myersguo/iteam（tsup → dist/cli/*.mjs）
│   │   ├── bin/{iteam,iteam-agent}.{ts,mjs}        # CLI 入口 + shim
│   │   └── src/
│   │       ├── agent-daemon.ts     # client 端 bridge：连 backend、拉起 agent
│   │       ├── chat-bridge.ts      # MCP Stdio Server，暴露 iteam_message_* 工具
│   │       ├── agent-launcher.ts   # 子进程拉起 + 一次性投递
│   │       ├── workspace.ts        # Agent 工作区初始化
│   │       ├── runtimes.ts         # 运行时探测（codex/claude/gemini/...）
│   │       ├── runtime/            # 各 driver（acp/claude/codex/oneshot）
│   │       └── cli/                # iteam CLI 子命令实现
│   ├── server/                 # @iteam/server（tsup → dist/cli/server.mjs）
│   │   └── src/
│   │       ├── server.ts           # 原生 HTTP/SSE 入口（稳定默认）
│   │       ├── http-server.ts      # 路由 + 静态托管
│   │       ├── core.ts             # 领域逻辑（IteamCore）
│   │       ├── store/              # json / sqlite / mysql 多后端
│   │       └── integrations/lark.ts
│   └── web/                     # @iteam/web（Vite → dist/index.html + assets/）
│       ├── vite.config.ts
│       └── src/{App.tsx,styles.css,UrlChangeReporter.tsx}
├── scripts/                    # smoke.ts / migrate-sqlite-to-mysql.ts ...
├── DESIGN.md · RESTRUCTURE_DESIGN.md
├── README.md                   # 英文文档
└── README_CN.md                # 中文文档
```

## 快速开始

### 安装

iTeam 已发布到 npm，可全局安装或用 `npx` 一次性运行（要求 Node ≥ 20）：

```bash
# 推荐：全局安装
npm install -g @myersguo/iteam

# 或一次性运行（无需安装）
npx @myersguo/iteam@latest --help
```

也支持源码方式开发：

```bash
git clone https://github.com/myersguo/iteam.git
cd iteam
corepack pnpm install
```

### 1. 启动 backend (server)

全局安装后：

```bash
iteam daemon start                     # 默认 http://127.0.0.1:4318
iteam daemon start --port 4400         # 指定端口
```

源码方式：

```bash
corepack pnpm run build:shared
corepack pnpm --filter @iteam/server dev
corepack pnpm --filter @iteam/server dev -- --port 4400
corepack pnpm --filter @iteam/server dev -- --no-serve-web
```

启动选项：

| 标志 / 环境变量 | 作用 |
| --- | --- |
| `--port` / `ITEAM_PORT` | 监听端口，默认 4318 |
| `--host` | 监听 host，默认 127.0.0.1 |
| `--serve-web` / `--no-serve-web` / `ITEAM_SERVE_WEB` | 是否托管静态 Web 产物，默认开启 |
| `--web-root` / `ITEAM_WEB_ROOT` | 自定义静态目录，例如 `packages/web/dist` |

数据持久化目录由环境变量 `ITEAM_HOME` 控制，默认为 `~/.iteam`。

### 2. 启动前端

```bash
corepack pnpm run dev:web   # Vite dev server，通常是 http://127.0.0.1:5173
```

打开浏览器即可看到三栏布局：导航 rail + 侧边栏 + 主面板。

生产近似的本地方式是先构建 Web，再让 backend 托管它：

```bash
corepack pnpm run build:web
ITEAM_WEB_ROOT=packages/web/dist corepack pnpm --filter @iteam/server dev
```

之后访问 `http://127.0.0.1:4318` 即可直接打开 Web UI（无需另起 dev server）。

### 3. 接入计算机（Connect command）

在 Web 端点 **Computers → +** 生成 connect 命令，在目标机器上执行（**无需 clone 仓库**）：

```bash
# 一次性运行（推荐，零安装，要求 Node ≥ 20）
npx @myersguo/iteam@latest daemon connect \
  --server-url http://127.0.0.1:4318 \
  --connect-token connect_xxxxxxxxxxxx

# 或先全局安装一次
npm install -g @myersguo/iteam
iteam daemon connect \
  --server-url http://127.0.0.1:4318 \
  --connect-token connect_xxxxxxxxxxxx
```

随后 daemon 会探测本机已安装的 `codex` / `claude` / `gemini` / `traecli` 运行时并上报。

### 4. 创建 Agent 并对话

在 Web 端 **Members → +** 创建 Agent；或：

```bash
iteam agent create my-codex --runtime codex
iteam agent list
iteam agent start <agent-id>

iteam message send '#all' '@my-codex 帮我总结今天的提交'
iteam message read '#all'
```

## CLI 速查

### iteam

```
iteam daemon start [--port 4318]
iteam daemon connect --server-url <url> --connect-token <token> [--space-id <id>] [--name <hostname>]
iteam daemon status
iteam web

iteam computer list

iteam agent create <name> [--runtime codex|claude|gemini]
iteam agent list
iteam agent start <agent-id>
iteam agent stop  <agent-id>

iteam channel list
iteam message send  <#channel> <message...>
iteam message read  <#channel>
iteam task create   <#channel> <title...> [--agent <agent-id>]
iteam task list
```

### iteam-agent（注入到 Agent 工作区 PATH）

```
iteam-agent server info
iteam-agent message check  [--target #all] [--limit 20]
iteam-agent message read   --target #all [--limit 30] [--around <msg_id>]
iteam-agent message search <query> [--target #all] [--limit 20]
iteam-agent message send   --target #all <message...>
```

环境变量：`ITEAM_AGENT_ID`、`ITEAM_SERVER_URL`。

## 主要 HTTP API

| Method | Path | 说明 |
| ------ | ---- | ---- |
| GET    | `/api/health`                       | daemon 健康检查 |
| GET    | `/api/state`                        | 完整状态快照（聚合所有资源，建议用于调试；新代码请使用下方分资源接口） |
| GET    | `/api/events`                       | SSE 状态事件流 |
| GET    | `/api/channels`                     | 频道列表 |
| GET    | `/api/messages/channel/:channelId?limit=&before=` | 当前频道消息分页；新 UI 应使用这个接口 |
| GET    | `/api/messages?target=&limit=&before=` | 指定 target 的消息分页；必须提供 `target`，用于 thread/DM 等非频道 target |
| GET    | `/api/agents`                       | Agent 列表 |
| GET    | `/api/computers`                    | 计算机列表 |
| GET    | `/api/tasks?target=&status=`        | 任务列表（可按 `target` / `status` 过滤） |
| GET    | `/api/humans`                       | 人类成员列表 |
| GET    | `/api/deliveries`                   | 投递队列 |
| GET    | `/api/pending-connections`          | 等待中的计算机邀请 |
| POST   | `/api/computers/connect-command`    | 生成 connect 命令 |
| POST   | `/api/computers/connect`            | 远程计算机心跳 |
| POST   | `/api/agents`                       | 创建 Agent |
| POST   | `/api/agents/:id/start`             | 启动 Agent |
| POST   | `/api/agents/:id/stop`              | 停止 Agent |
| POST   | `/api/agents/:id/runtime-status`    | runtime 状态上报 |
| POST   | `/api/agents/:id/runtime-event`     | runtime 事件上报 |
| POST   | `/api/messages`                     | 发送消息（自动派发 mention） |
| POST   | `/api/tasks`                        | 创建任务 |
| PATCH  | `/api/tasks/:id`                    | 更新任务状态 |
| POST   | `/api/deliveries/:id/result`        | Agent 投递结果回调 |

## 数据模型概览

```
State {
  meta, computers[], pendingComputerConnections[],
  humans[], agents[], channels[],
  messages[], deliveries[], tasks[], events[]
}
```

- **Channel.target** 形如 `#all`；线程 target 形如 `#all:msg_xxx`
- **Message.mentions** 自动从文本 `@handle` 解析，命中的 Agent 会被排进 `deliveries` 队列
- **Delivery** 是消息投递任务，由 client 端的 `agent-daemon` 拉取并通过 `agent-launcher.deliver()` 调用 runtime
- **Task.threadTarget** = `${target}:${messageId}`，所有任务讨论自动落到对应线程

## 开发命令

本仓库是 **pnpm workspace**,统一用 `corepack pnpm`（pnpm 11+）。依赖从公共 npm registry 解析。

```bash
# 一次性：安装全部 workspace 依赖
corepack pnpm install

# 全量构建（按依赖顺序：shared → client → server → web）
corepack pnpm run build

# 单独构建某个模块
corepack pnpm run build:shared   # @iteam/shared   (tsc)
corepack pnpm run build:client   # @myersguo/iteam (tsup → dist/cli/*.mjs)
corepack pnpm run build:server   # @iteam/server   (tsup → dist/cli/server.mjs)
corepack pnpm run build:web      # @iteam/web      (vite build → dist/index.html + assets/)

# 全部包类型检查 / 清理
corepack pnpm run typecheck
corepack pnpm run clean
# 开发态（免构建；tsx / Vite dev server 带 HMR）
corepack pnpm run dev:web        # Vite dev server，代理 /api、/auth 到 :4318
corepack pnpm run dev:server     # tsx 跑原生 server.ts

# 端到端冒烟测试（拉起 server，跑 driver + 鉴权流程）
corepack pnpm exec tsx scripts/smoke.ts
```

> **先编 shared**：client/server 产物会内联 `@iteam/shared`,且 `typecheck` 需要
> `packages/shared/dist` 已存在才能解析它 —— 全新 checkout 上先 `build`（或
> `build:shared`）再 `typecheck`。
>
> 稳定生产入口是 `packages/server/dist/cli/server.mjs`（原生 `node:http`）。

## 设计哲学

- **本地优先**：默认所有数据存于 `~/.iteam/state.db`，可手动备份与迁移
- **类型驱动**：`packages/shared/src/types.ts` 是领域唯一事实源，前端按需镜像
- **无构建运行**：`tsx` 直接执行 TypeScript，开发即生产
- **编辑式美学**：参见 [`DESIGN.md`](./DESIGN.md)，向 Anthropic Editorial 设计语言致敬

## 登录 Provider（可选）

iTeam 默认仍然是本地优先、无需登录。单人本地工作区可以保持 `ITEAM_AUTH_MODE=none`。如果部署成多人共享 Web 工作区，可以启用 OAuth Provider，让不同浏览器用户显示为不同 Human。

GitHub OAuth App 示例：

```bash
ITEAM_AUTH_MODE=oauth \
ITEAM_AUTH_PROVIDERS=github \
ITEAM_PUBLIC_URL=http://127.0.0.1:5199 \
ITEAM_SESSION_SECRET=<random-session-secret> \
ITEAM_GITHUB_CLIENT_ID=<github-client-id> \
ITEAM_GITHUB_CLIENT_SECRET=<github-client-secret> \
iteam daemon start
```

也可以通过 `ITEAM_AUTH_PROVIDERS=oauth2` 和 `ITEAM_OAUTH2_*` 环境变量配置通用 OAuth2 Provider。

注意：

- 不要把 OAuth client secret 或 `ITEAM_SESSION_SECRET` 提交到仓库；应通过环境变量或进程管理器注入。
- 每个 OAuth App 都需要登记回调地址 `{ITEAM_PUBLIC_URL}/auth/callback`。
- 启用 OAuth 后，Web 创建的消息和任务会归因到当前登录用户；Agent、Computer、外部入口仍继续使用原有 token 鉴权。

## 存储后端

`Store` 已被抽象成 `IStore` 接口（见 `packages/server/src/store/`），通过环境变量 `ITEAM_STORE` 切换底层实现。SQLite / MySQL 是正式支持的 repository-backed 后端：持久化业务读路径默认以数据库为事实来源；进程内 state 仅保留运行时兼容和通知语义。

| 后端 | 启用方式 | 数据位置 | 额外依赖 |
|---|---|---|---|
| **SQLite（默认）** | 不设置 / `ITEAM_STORE=sqlite` | `~/.iteam/state.db`（可用 `ITEAM_SQLITE_FILE` 覆盖） | `npm i better-sqlite3` |
| MySQL | `ITEAM_STORE=mysql` | 默认 db `iteam`，规范化的 `iteam_*` 物理表 | `npm i mysql2` |
| JSON（legacy/dev-only） | `ITEAM_STORE=json` | `~/.iteam/state.json` 单文件 | 无，保留给本地实验和旧数据检查 |

SQLite / MySQL 后端均使用规范化的 `iteam_*` 关系表（spaces、messages、tasks、deliveries、artifacts、外部入口等），首次启动时由代码自动 `CREATE TABLE IF NOT EXISTS`，无需手动建表。SQLite 后端检测到旧的单行 `state` 表会自动迁移并清理。

MySQL 配置环境变量：

```
ITEAM_MYSQL_URL=mysql://user:pwd@host:3306/iteam   # 优先使用
# 或者拆分配置：
ITEAM_MYSQL_HOST=127.0.0.1
ITEAM_MYSQL_PORT=3306
ITEAM_MYSQL_USER=root
ITEAM_MYSQL_PASSWORD=
ITEAM_MYSQL_DATABASE=iteam
```

## 部署指导

iTeam 没有云端服务，部署本质上就是「在某台机器上把 daemon 跑起来 + 在浏览器访问 Web」。下列三种场景按由简到繁排列。

### 场景 A：单机本地开发（默认 SQLite 后端）

```bash
git clone <repo>
cd iteam
corepack pnpm install
corepack pnpm run dev:server &    # 后端 http://127.0.0.1:4318
corepack pnpm run dev:web         # Vite dev server
```

数据落在 `~/.iteam/state.db`，备份可使用 SQLite `.backup` 或直接在 daemon 停止后拷贝该文件。

### 场景 B：长驻服务器（推荐 SQLite 后端）

适合放在自己的开发机 / 一台 VPS 上，多人浏览器共享同一份状态。

1. **构建前端静态资源**

   ```bash
   corepack pnpm install
   corepack pnpm run build    # server → packages/server/dist/cli/server.mjs; web → packages/web/dist/
   ```

2. **配置环境变量**

   ```bash
   export ITEAM_HOME=/var/lib/iteam        # 数据目录，需可写
   export ITEAM_STORE=sqlite               # 启用 SQLite 后端
   export ITEAM_PORT=4318                  # 监听端口
   # 可选：ITEAM_SQLITE_FILE=/var/lib/iteam/state.db
   ```

3. **启动 daemon**

   推荐用进程守护（systemd / pm2 / supervisord）。systemd 示例：

   ```ini
   # /etc/systemd/system/iteam.service
   [Unit]
   Description=iTeam local-first agent workspace
   After=network.target

   [Service]
   Type=simple
   User=iteam
   WorkingDirectory=/opt/iteam
   Environment=ITEAM_HOME=/var/lib/iteam
   Environment=ITEAM_STORE=sqlite
   Environment=ITEAM_PORT=4318
   Environment=ITEAM_WEB_ROOT=/opt/iteam/packages/web/dist
   ExecStart=/usr/bin/node /opt/iteam/packages/server/dist/cli/server.mjs --port 4318
   Restart=on-failure

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now iteam
   journalctl -u iteam -f
   ```

4. **托管前端**

   - 简易方案：server 直接托管 `packages/web/dist`（见上面的 `ITEAM_WEB_ROOT`）。
   - 反向代理方案（推荐）：用 Nginx 把前端和 API 合并到同一域名：

     ```nginx
     server {
       listen 80;
       server_name iteam.example.com;

       root /opt/iteam/packages/web/dist;
       index index.html;

       location /api/ {
         proxy_pass http://127.0.0.1:4318;
         proxy_http_version 1.1;
         proxy_set_header Connection "";
         proxy_buffering off;          # SSE 必须关闭缓冲
         proxy_read_timeout 1d;
       }

       location / {
         try_files $uri /index.html;
       }
     }
     ```

5. **备份**

   ```bash
   sqlite3 /var/lib/iteam/state.db ".backup /backup/state-$(date +%F).db"
   ```

### 场景 C：团队共享（MySQL 后端）

当 daemon 与数据库分离、或多个 daemon 实例需要共享状态时使用。

1. **准备 MySQL**

   ```sql
   CREATE DATABASE iteam DEFAULT CHARSET utf8mb4;
   CREATE USER 'iteam'@'%' IDENTIFIED BY 'change-me';
   GRANT ALL ON iteam.* TO 'iteam'@'%';
   FLUSH PRIVILEGES;
   ```

   首次启动 daemon 时会自动创建所需的 `iteam_*` 表，无需手动执行 DDL。

2. **配置 daemon**

   ```bash
   export ITEAM_HOME=/var/lib/iteam
   export ITEAM_STORE=mysql
   export ITEAM_MYSQL_URL=mysql://iteam:change-me@db.example.com:3306/iteam
   export ITEAM_PORT=4318

   npm install               # 含 mysql2
   corepack pnpm run build
   ITEAM_WEB_ROOT=packages/web/dist node packages/server/dist/cli/server.mjs --port 4318
   ```

   或仍套用上面的 systemd unit，把 `Environment` 替换成 MySQL 配置即可。

3. **多机接入**

   `ITEAM_HOME` 仍是本地目录（用于存放每个 Agent 的 workspace 文件），但持久业务数据存在 MySQL 里，多个 daemon 实例可指向同一个数据库实现共享。当前 SQL 后端采用 repository-backed 读模型与行级增量持久化；单 daemon 写入通过事务保持一致，多 daemon 同写仍建议引入协调层或进一步的乐观锁/版本控制。

4. **备份**

   ```bash
   mysqldump --single-transaction iteam > iteam-$(date +%F).sql
   ```

### 远程计算机接入（任一场景通用）

在 daemon 所在机器之外的机器上运行 Agent 时，使用 connect-token：

```bash
# 1. 在 Web 端 Computers → + 生成命令；或直接调 API：
curl -s -X POST http://<daemon-host>:4318/api/computers/connect-command \
  -H 'content-type: application/json' \
  -d '{"label":"laptop-2","serverUrl":"http://<daemon-host>:4318"}'

# 2. 在目标机器上：
ITEAM_SERVER_URL=http://<daemon-host>:4318 \
  iteam daemon connect \
  --server-url http://<daemon-host>:4318 \
  --connect-token connect_xxxxxxxxxxxx
```

目标机器会探测本地 `codex` / `claude` / `gemini` 二进制并上报，之后该机器上的 Agent 可被 daemon 远程拉起 / 投递消息。

### 部署 Checklist

- [ ] `corepack pnpm run typecheck` / `corepack pnpm exec tsx scripts/smoke.ts` 在目标 Node.js 版本下通过
- [ ] `ITEAM_HOME` 指向持久化目录，进程用户可读写
- [ ] 选定 `ITEAM_STORE` 与对应依赖已安装（SQLite/MySQL）
- [ ] daemon 监听端口仅对可信网络开放（默认仅绑 `127.0.0.1`）
- [ ] 反向代理对 `/api/events` 关闭缓冲并放宽超时（SSE 长连接）
- [ ] 周期性备份（JSON 拷贝文件 / SQLite `.backup` / MySQL `mysqldump`）

## License

MIT © [myersguo](https://github.com/myersguo)

## 发布到 npm（仅维护者）

```bash
# 从仓库根目录：检查、提交、bump packages/client、推送 main + tag
make release MSG="chore: release" BUMP=patch

# 手动 dry run / 发布单个 npm 包
cd packages/client

# 登录（一次性）
npm login

# 本地预演 —— 看看哪些文件会被打进 tarball
npm pack --dry-run

# 发布
npm publish

# 后续版本迭代
npm version patch
git push origin main --follow-tags
npm publish
```
