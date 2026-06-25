# iTeam 代码评审 Issue 清单

> 生成日期: 2026-06-25  
> 评审范围: master 分支当前快照  
> 评审者: review subagent

## 摘要
- 总计 issue 数: 8
- 严重程度分布: P0 x 2, P1 x 4, P2 x 2

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

### [P1] 生成 Agent 脚本时的 Shell 注入风险
- 文件: `src/workspace.ts` (~L116)
- 类型: 安全 / 命令注入
- 现象: 在 `prepareAgentWorkspace` 函数中生成 `iteam-agent` 包装脚本时，直接将变量 `serverUrl` 和 `agent.id` 嵌入到 Shell 脚本字符串中：
  ```sh
  export ITEAM_AGENT_ID="${agent.id}"
  export ITEAM_SERVER_URL="${serverUrl}"
  ```
- 影响: 如果 `serverUrl` 配置被注入了恶意字符（如 `"; rm -rf / #`），在生成的脚本被执行时将触发命令注入攻击。
- 建议: 对嵌入 Shell 脚本的变量进行严格转义（单引号 + `'\''` 转义），或改用 JSON 配置文件等更安全的方式传递环境变量。

### [P1] 同步且非原子的状态持久化机制
- 文件: `src/store/json-store.ts`, `src/store/base.ts`
- 类型: 数据安全 / 性能
- 现象: 在 `JsonStore` 实现中，`persist` 方法使用同步的 `writeFileSync` 写入 JSON 文件。而在 `BaseStore.mutate` 中，每次状态变更都会触发一次 `persist`。
- 影响: 1. `writeFileSync` 不是原子操作，写入过程中系统崩溃会导致 `state.json` 损坏；2. 同步 IO 阻塞主线程。
- 建议: 使用"先写临时文件再 rename"的原子写入策略；后续可引入异步 IO 与 debounce。

### [P1] 运行时 Argument 注入漏洞
- 文件: `src/runtime/profiles.ts:43`, `src/runtime/oneshot-driver.ts:231`
- 类型: 安全 / 命令注入
- 现象: `renderProfileValue` 使用正则简单替换 `{{prompt}}` 等变量。对于 `opencode` 等预定义 runtime，Prompt 内容会直接作为子进程的参数。
- 影响: 如果 Prompt 内容包含以 `-` 开头的字符串，攻击者可以向底层 CLI 工具注入非预期的命令行参数。
- 建议: 在拼接命令行参数时，确保参数被正确引用或使用 `--` 终止符。

### [P1] 广泛使用 `any` 绕过类型系统
- 文件: `src/http-server.ts` 多处, `src/http-client.ts`
- 类型: 类型安全 / 可维护性
- 现象: `parseJsonBody<any>(req)` 被大量使用，且 API 输入直接传递给核心逻辑，缺乏显式的 Schema 校验（如 Zod）。
- 影响: 非法输入可能导致核心逻辑在深层调用链中产生意外崩溃。
- 建议: 在 HTTP 层引入 Zod 校验库，将 `any` 替换为具体的类型定义。

### [P2] 实例锁存在潜在竞态条件
- 文件: `src/machine-lock.ts`
- 类型: 鲁棒性
- 现象: `acquireLock` 逻辑先通过 `isProcessAlive(pid)` 检查旧 PID，然后再执行 `writeFile`。
- 影响: 在并发启动时，两个进程可能同时发现旧进程已死并尝试写入自己的 PID。
- 建议: 使用文件系统的独占写入（`x` flag）来确保原子性。

### [P2] 跨平台兼容性缺失 (Unix-Only)
- 文件: `src/agent-daemon.ts:355`
- 类型: 可维护性 / 兼容性
- 现象: 代码中直接使用 `execFileSync("ps", ...)` 来获取系统进程列表，这是 Unix-only 操作。
- 影响: 在 Windows 环境下，该功能将直接报错。
- 建议: 使用 `ps-list` 等跨平台库，或针对不同操作系统提供适配实现。

## 备注
- 本次评审仅基于静态代码分析，未进行动态运行测试。
- 前端 `web/src/App.tsx` 文件较大（140KB），建议后续拆分组件以提升可维护性。
