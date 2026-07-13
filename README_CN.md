# iTeam

> 本地优先的人机协作工作区——把人、AI Agent、计算机和任务装进同一个聊天室。

iTeam 是一个完全跑在本地的多 Agent 协作平台。它把 Codex CLI、Claude Code、Gemini CLI 等编码 Agent 接入一个统一的聊天 / 任务 / 看板界面，让你像和同事协作一样指挥它们。所有数据保存在本地 `~/.iteam/state.json`，不依赖任何云端服务。

## 核心能力

- **频道与线程**：基于 `#channel` 与 `target:msgId` 形态的会话模型，支持任务关联线程
- **Agent 编排**：动态启停 Codex / Claude / Gemini Agent，按 `@handle` 转发消息
- **任务看板**：todo / in_progress / in_review / done 四态看板，支持指派 Agent
- **多机协同**：通过 connect-token 把额外计算机加入工作区，跨机分发 Agent 与消息投递
- **MCP 桥接**：每个 Agent 自带 `iteam_message_*` MCP 工具，可在 runtime 内主动读消息、发消息、查上下文
- **编辑式 Web UI**：参考 Anthropic 设计语言，奶油色画布 + 珊瑚色强调 + 衬线标题

## 技术栈

- 后端：Node.js 内置 HTTP server + SSE，TypeScript 全量类型
- 前端：React 19 + TypeScript + Vite，Cormorant Garamond / Inter / JetBrains Mono
- 运行时：[`tsx`](https://github.com/privatenumber/tsx) 直接执行 `.ts`，无构建步骤
- Agent 通信：[Model Context Protocol](https://modelcontextprotocol.io/) Stdio Server

## 目录结构

```
iteam/
├── bin/                    # CLI 入口
│   ├── iteam.mjs           # 用户 CLI shim（npm bin）
│   ├── iteam.ts            # iteam 命令实现
│   ├── iteam-agent.mjs     # Agent 内部 CLI shim
│   └── iteam-agent.ts      # iteam-agent 命令实现
├── src/                    # 后端 TypeScript 源码
│   ├── types.ts            # 领域类型定义（State / Agent / Message / Task ...）
│   ├── server.ts           # 远端 backend HTTP/SSE 入口
│   ├── store.ts            # Store 兼容门面（re-export）
│   ├── store/              # 存储抽象与多后端实现
│   │   ├── types.ts        # IStore 接口
│   │   ├── base.ts         # 公共状态机 + sanitize/initialState
│   │   ├── json-store.ts   # 默认本地 JSON 文件后端
│   │   ├── sqlite-store.ts # better-sqlite3 后端
│   │   ├── mysql-store.ts  # mysql2 后端
│   │   └── factory.ts      # createStore() / 后端选择
│   ├── runtime.ts          # Agent 生命周期管理
│   ├── runtimes.ts         # 运行时探测（codex/claude/gemini/opencode）
│   ├── agent-launcher.ts   # 子进程拉起 + 一次性投递
│   ├── chat-bridge.ts      # MCP Stdio Server，暴露 iteam_message_* 工具
│   ├── agent-daemon.ts     # client 端 bridge：连 backend、拉起 agent
│   ├── workspace.ts        # Agent 工作区初始化
│   ├── http-client.ts      # 内部 HTTP 封装
│   └── lib.ts              # 通用工具（id/时间/JSON/fingerprint）
├── web/src/                # 前端
│   ├── App.tsx             # 主组件（聊天 / 任务 / 成员 / 计算机）
│   └── styles.css          # 编辑式设计 token
├── scripts/
│   └── smoke.ts            # 端到端冒烟测试
├── DESIGN.md               # 视觉设计语言说明
├── tsconfig.json
└── package.json
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
npm install
```

### 1. 启动 backend (server)

全局安装后：

```bash
iteam daemon start                     # 默认 http://127.0.0.1:4318
iteam daemon start --port 4400         # 指定端口
```

源码方式：

```bash
npm run server                         # 等价于上面
npm run server -- --port 4400
npm run server -- --no-serve-web       # 远端 backend 不托管 web
```

> 兼容别名：`npm run daemon` 仍指向同一入口。

启动选项：

| 标志 / 环境变量 | 作用 |
| --- | --- |
| `--port` / `ITEAM_PORT` | 监听端口，默认 4318 |
| `--host` | 监听 host，默认 127.0.0.1 |
| `--serve-web` / `--no-serve-web` / `ITEAM_SERVE_WEB` | 是否托管 `dist/` 静态产物，默认开启 |
| `--web-root` / `ITEAM_WEB_ROOT` | 自定义静态目录，仅在 serveWeb 开启时生效 |

数据持久化目录由环境变量 `ITEAM_HOME` 控制，默认为 `~/.iteam`。

### 2. 启动前端

```bash
npm run dev                 # http://127.0.0.1:5173
```

打开浏览器即可看到三栏布局：导航 rail + 侧边栏 + 主面板。

> backend 默认会托管 `dist/` 静态产物，全局安装后访问 `http://127.0.0.1:4318` 即可直接打开 Web UI（无需另起 dev server）。

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

```bash
npm run dev          # 启动 vite dev server (web)
npm run server       # 启动远端 backend (别名：npm run daemon)
npm run agent-daemon # 启动 client 端 agent-daemon
npm run cli -- ...   # 调用 iteam CLI（用 tsx）
npm run typecheck    # 全项目 tsc --noEmit
npm run build        # 构建前端到 dist/
npm run smoke        # 端到端冒烟测试
```

## 设计哲学

- **本地优先**：默认所有数据存于 `~/.iteam/state.json`，可手动备份与迁移
- **类型驱动**：`src/types.ts` 是后端唯一事实源，前端按需镜像
- **无构建运行**：`tsx` 直接执行 TypeScript，开发即生产
- **编辑式美学**：参见 [`DESIGN.md`](./DESIGN.md)，向 Anthropic Editorial 设计语言致敬

## 存储后端

`Store` 已被抽象成 `IStore` 接口（见 `src/store/`），通过环境变量 `ITEAM_STORE` 切换底层实现。所有后端共享 `snapshot / mutate / emit / subscribe` 语义，业务代码无需改动。

| 后端 | 启用方式 | 数据位置 | 额外依赖 |
|---|---|---|---|
| **JSON（默认）** | 不设置 / `ITEAM_STORE=json` | `~/.iteam/state.json` 单文件 | 无，零依赖纯本地 |
| SQLite | `ITEAM_STORE=sqlite` | `~/.iteam/state.db`（可用 `ITEAM_SQLITE_FILE` 覆盖） | `npm i better-sqlite3` |
| MySQL | `ITEAM_STORE=mysql` | 默认 db `iteam`，10 张 `iteam_*` 物理表 | `npm i mysql2` |

SQLite / MySQL 后端均使用 10 张关系表（`iteam_humans / iteam_computers / iteam_pending_connections / iteam_agents / iteam_channels / iteam_channel_members / iteam_messages / iteam_tasks / iteam_deliveries / iteam_events`），首次启动时由代码自动 `CREATE TABLE IF NOT EXISTS`，无需手动建表。SQLite 后端检测到旧的单行 `state` 表会自动迁移并清理。

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

### 场景 A：单机本地开发（默认 JSON 后端）

```bash
git clone <repo>
cd iteam
npm install
npm run server &           # 后端 http://127.0.0.1:4318
npm run dev                # 前端 http://127.0.0.1:5173
```

数据落在 `~/.iteam/state.json`，备份直接拷贝该文件即可。

### 场景 B：长驻服务器（推荐 SQLite 后端）

适合放在自己的开发机 / 一台 VPS 上，多人浏览器共享同一份状态。

1. **构建前端静态资源**

   ```bash
   npm install
   npm run build              # 输出到 dist/
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
   Environment=ITEAM_SERVE_WEB=false
   ExecStart=/usr/bin/npx tsx ./src/server.ts --port 4318 --no-serve-web
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

   - 简易方案：用任意静态文件服务器把 `dist/` 跑起来（如 `npx serve dist -l 5173`）。
   - 反向代理方案（推荐）：用 Nginx 把前端和 API 合并到同一域名：

     ```nginx
     server {
       listen 80;
       server_name iteam.example.com;

       root /opt/iteam/dist;
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

   首次启动 daemon 时会自动创建 10 张 `iteam_*` 表，无需手动执行 DDL。

2. **配置 daemon**

   ```bash
   export ITEAM_HOME=/var/lib/iteam
   export ITEAM_STORE=mysql
   export ITEAM_MYSQL_URL=mysql://iteam:change-me@db.internal:3306/iteam
   export ITEAM_PORT=4318

   npm install               # 含 mysql2
   npx tsx ./src/server.ts --port 4318
   ```

   或仍套用上面的 systemd unit，把 `Environment` 替换成 MySQL 配置即可。

3. **多机接入**

   `ITEAM_HOME` 仍是本地目录（用于存放每个 Agent 的 workspace 文件），但「状态」存在 MySQL 里，多个 daemon 实例可指向同一个数据库实现共享。注意：当前实现是「整状态全量重写 + 串行写链」的粗粒度持久化，单 daemon 写入是原子的；多 daemon 同写需自行加协调层。

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

- [ ] `npm run typecheck` / `npm run smoke` 在目标 Node.js 版本下通过
- [ ] `ITEAM_HOME` 指向持久化目录，进程用户可读写
- [ ] 选定 `ITEAM_STORE` 与对应依赖已安装（SQLite/MySQL）
- [ ] daemon 监听端口仅对可信网络开放（默认仅绑 `127.0.0.1`）
- [ ] 反向代理对 `/api/events` 关闭缓冲并放宽超时（SSE 长连接）
- [ ] 周期性备份（JSON 拷贝文件 / SQLite `.backup` / MySQL `mysqldump`）

## License

MIT © [myersguo](https://github.com/myersguo)

## 发布到 npm（仅维护者）

```bash
# 0. 登录（一次性）
npm login

# 1. 本地预演 —— 看看哪些文件会被打进 tarball
npm pack --dry-run

# 2. 发布（prepublishOnly 会自动 typecheck + build）
npm publish

# 3. 后续版本迭代
npm version patch        # 0.1.0 -> 0.1.1
git push --follow-tags
npm publish
```

