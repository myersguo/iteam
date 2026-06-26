# iTeam 代码评审 Issue 清单

> 生成日期: 2026-06-26  
> 评审范围: feature_agents_daily_vv2 分支当前快照 (基于 03a6ecb)  
> 评审者: code-review subagent

## 摘要
- 总计 issue 数: 8
- 严重程度分布: P0 x 2, P1 x 4, P2 x 2
- 已修复(上期): P1 x 2 (Shell 注入 + JsonStore 原子写入)

## Issue 列表

### [P0] 核心 API 缺乏身份鉴权与越权漏洞
- 文件: `src/http-server.ts`
- 类型: 安全 / 访问控制
- 现象: 绝大多数修改状态的 API（如 `/api/messages`, `/api/tasks`, `/api/agents` 的 POST/PATCH）以及获取完整状态的 API (`/api/state`) 均没有调用 `requireComputerAuth` 进行鉴权。仅 `/api/agents/:id/runtime-status`、`/api/agents/:id/runtime-event`、`/api/deliveries/:id/result` 等少数回调端点有鉴权。
- 影响: 只要能访问到守护进程端口（默认为 `0.0.0.0:4318`），任何人都可以读取系统完整消息历史、冒充他人发送消息、控制 Agent 启停或修改任务状态。
- 建议: 为所有非公开 API 引入基于 Token 的鉴权，确保请求携带合法的 `X-Iteam-Connection` 头部。

### [P0] 未授权的系统状态全量泄露
- 文件: `src/http-server.ts:230`
- 类型: 安全 / 隐私
- 现象: `GET /api/state` 接口直接返回 `core.snapshot()`，包含系统内所有的 Human, Agent, Channel, Message, Task 信息。
- 影响: 攻击者可一键获取所有协作数据、环境配置、敏感配置，为进一步攻击提供便利。
- 建议: 严格限制 `/api/state` 的访问权限，或仅返回当前用户/Agent 有权查看的子集。

### [P1] 运行时 Argument 注入漏洞
- 文件: `src/runtime/profiles.ts:25`, `src/runtime/oneshot-driver.ts:242,255`
- 类型: 安全 / 命令注入
- 现象: 
  - `profiles.ts` 中 opencode profile 的 args 为 `["run", "{{prompt}}"]`，未在 prompt 前加 `--` 终止选项解析。
  - `oneshot-driver.ts` 中 codex 路径 `codexArgs.push(prompt)` 和 traecli 路径直接 `prompt` 作为最后一个参数，均未加 `--`。
- 影响: 如果 Prompt 内容包含以 `-` 开头的字符串，攻击者可以向底层 CLI 工具注入非预期的命令行参数。
- 建议: 在所有 prompt 作为位置参数传递给 spawn 之前插入 `--` 终止符。

### [P1] 实例锁存在潜在竞态条件
- 文件: `src/machine-lock.ts:45`
- 类型: 鲁棒性
- 现象: `acquireLock` 在检查旧 PID 后直接使用 `writeFile` 写入锁文件，非原子操作。
- 影响: 在并发启动时，两个进程可能同时发现旧进程已死并尝试写入自己的 PID，导致锁损坏。
- 建议: 使用临时文件 + rename 的原子写入策略。

### [P1] 广泛使用 `any` 绕过类型系统
- 文件: `src/http-server.ts` 多处, `src/http-client.ts`
- 类型: 类型安全 / 可维护性
- 现象: `parseJsonBody<any>(req)` 被大量使用，且 API 输入直接传递给核心逻辑，缺乏显式的 Schema 校验（如 Zod）。
- 影响: 非法输入可能导致核心逻辑在深层调用链中产生意外崩溃。
- 建议: 在 HTTP 层引入 Zod 校验库，将 `any` 替换为具体的类型定义。

### [P1] `BaseStore.emit` 中重复 persist 导致写放大
- 文件: `src/store/base.ts:249-261`
- 类型: 性能
- 现象: `emit` 方法在每次事件触发时都会调用 `this.persist(this.state)`，而 `mutate` 已经调用了一次 persist。在高频事件场景下（如 SSE 推送），会导致显著的写放大。
- 影响: 磁盘 IO 压力增大，可能影响整体吞吐。
- 建议: 将 `emit` 中的 persist 改为 debounce 或标记脏位，由 `mutate` 统一刷盘。

### [P2] 跨平台兼容性缺失 (Unix-Only)
- 文件: `src/agent-daemon.ts:355`
- 类型: 可维护性 / 兼容性
- 现象: 代码中直接使用 `execFileSync("ps", ...)` 来获取系统进程列表，这是 Unix-only 操作。
- 影响: 在 Windows 环境下，该功能将直接报错。
- 建议: 使用 `ps-list` 等跨平台库，或针对不同操作系统提供适配实现。

### [P2] 前端 Web UI 组件过大
- 文件: `web/src/App.tsx` (~140KB)
- 类型: 可维护性
- 现象: 单个组件文件承载了几乎所有 UI 逻辑，缺乏组件拆分。
- 影响: 维护困难，新增功能容易引入回归。
- 建议: 按功能模块拆分为独立组件（ChannelView, TaskBoard, AgentPanel 等）。

## 备注
- 本次评审基于静态代码分析，未进行动态运行测试。
- 上期 P1 修复（Shell 注入 + JsonStore 原子写入）已合入，本期不再列出。
