# iTeam 代码评审 Issue 清单

> 生成日期: 2026-06-25  
> 评审范围: feature_agents_daily 分支当前快照  
> 评审者: review subagent

## 摘要
- 总计 issue 数: 10
- 严重程度分布: P0 x 2, P1 x 7, P2 x 1

## Issue 列表

### [P0] 核心 API 缺乏身份鉴权与越权漏洞
- 文件: `src/http-server.ts:230`, `src/http-server.ts:358`, `src/http-server.ts:435` 等
- 类型: 安全 / 访问控制
- 现象: 绝大多数修改状态的 API（如 `/api/messages`, `/api/tasks`, `/api/agents` 的 POST/PATCH）以及获取完整状态的 API (`/api/state`) 均没有调用 `requireComputerAuth` 进行鉴权。
- 影响: 只要能访问到守护进程端口（默认为 `0.0.0.0:4318`），任何人都可以读取系统完整消息历史、冒充他人发送消息、控制 Agent 启停或修改任务状态。这在公共网络环境下构成了极其严重的安全风险。
- 建议: 为所有非公开 API 引入基于 Token 的鉴权，确保请求携带合法的 `X-Iteam-Connection` 头部。

### [P0] 未授权的系统状态全量泄露
- 文件: `src/http-server.ts:230`
- 类型: 安全 / 隐私
- 现象: `GET /api/state` 接口直接返回 `core.snapshot()`，包含系统内所有的 Human, Agent, Channel, Message, Task 信息。
- 影响: 攻击者可以一键获取所有协作数据、环境配置、甚至部分脱敏后的敏感配置，为进一步攻击（如针对性消息伪造）提供便利。
- 建议: 严格限制 `/api/state` 的访问权限，或仅返回当前用户/Agent 有权查看的子集。

### [P1] 同步且非原子的状态持久化机制
- 文件: `src/store/json-store.ts:28`, `src/store/base.ts:241`
- 类型: 性能 / 数据安全
- 现象: 在 `JsonStore` 实现中，`persist` 方法使用同步的 `writeFileSync` 写入 JSON 文件。而在 `BaseStore.mutate` 中，每次状态变更（发消息、更新任务等）都会触发一次 `persist`。
- 影响: 1. 性能瓶颈：当状态文件增大时，同步 IO 会长时间阻塞 Node.js 主线程，导致 HTTP 响应延迟。 2. 数据损坏：`writeFileSync` 不是原子操作，如果写入过程中系统崩溃，`state.json` 将损坏导致数据丢失。
- 建议: 使用异步 IO 写入，并采用"先写临时文件再 rename"的原子写入策略。考虑引入写入合并（Debounce）机制。

### [P1] 生成 Agent 脚本时的 Shell 注入风险
- 文件: `src/workspace.ts:112`
- 类型: 安全 / 命令注入
- 现象: 在 `prepareAgentWorkspace` 函数中生成 `iteam-agent` 包装脚本时，直接将变量 `serverUrl` 嵌入到 Shell 脚本字符串中：`export ITEAM_SERVER_URL="${serverUrl}"`。
- 影响: 如果 `serverUrl` 配置被注入了恶意字符（如 `"; rm -rf / #`），在生成的脚本被执行时（如 Agent 启动），将触发命令注入攻击。
- 建议: 对嵌入 Shell 脚本的变量进行严格转义，或改用 JSON 配置文件等更安全的方式传递环境变量。

### [P1] 运行时 Argument 注入漏洞
- 文件: `src/runtime/profiles.ts:43`, `src/runtime/oneshot-driver.ts:231`
- 类型: 安全 / 命令注入
- 现象: `renderProfileValue` 使用正则简单替换 `{{prompt}}` 等变量。对于 `opencode` 等预定义 runtime，Prompt 内容会直接作为子进程的参数。
- 影响: 如果 Prompt 内容包含以 `-` 开头的字符串，攻击者可以向底层 CLI 工具注入非预期的命令行参数（Argument Injection），从而改变工具行为或绕过安全限制。
- 建议: 在拼接命令行参数时，确保参数被正确引用或使用 `--` 终止符，防止参数注入。

### [P1] 内存密集型状态克隆与快照机制
- 文件: `src/store/base.ts:241`, `src/lib.ts:41`
- 类型: 性能 / 内存管理
- 现象: `core.snapshot()` 被频繁调用，而其实现是通过 `JSON.parse(JSON.stringify(state))` 进行深拷贝。
- 影响: 随着消息和任务数量增加，这种"全量克隆"方式会极度消耗 CPU 和内存，尤其是在高频请求（如 SSE 推送或热点轮询）场景下，容易导致 OOM 或频繁垃圾回收导致的卡顿。
- 建议: 采用不可变数据结构（如 Immer）或增量快照机制来优化状态读取。

### [P1] 跨平台兼容性缺失 (Unix-Only)
- 文件: `src/agent-daemon.ts:355`
- 类型: 可维护性 / 兼容性
- 现象: 代码中直接使用 `execFileSync("ps", ...)` 来获取系统进程列表，这是典型的类 Unix 系统操作。
- 影响: 在 Windows 环境下，该功能将直接报错导致守护进程无法正常监控 Agent 状态。
- 建议: 使用 `ps-list` 等跨平台库，或针对不同操作系统提供适配实现。

### [P1] 敏感配置信息明文存储
- 文件: `src/store/json-store.ts:18`, `src/core.ts:460`
- 类型: 安全
- 现象: 外部 Bot 配置（如 Lark/Feishu 的 `appSecret`）在内存和磁盘文件 `state.json` 中均以明文形式存储。
- 影响: 尽管 API 返回时进行了脱敏，但任何拥有本地文件系统访问权限的人都可以直接窃取这些机密凭据。
- 建议: 考虑对磁盘存储的敏感字段进行加密，或支持从环境变量/Secret Store 加载机密。

### [P1] 广泛使用 `any` 绕过类型系统
- 文件: `src/http-server.ts:282` 等多处, `src/http-client.ts:7`
- 类型: 类型安全 / 可维护性
- 现象: `parseJsonBody<any>(req)` 被大量使用，且 API 输入直接传递给核心逻辑，缺乏显式的 Schema 校验（如 Zod）。
- 影响: 降低了重构的信心，且非法的输入可能导致核心逻辑在深层调用链中产生意外崩溃，难以定位。
- 建议: 在 HTTP 层引入 Zod 等校验库，将 `any` 替换为具体的类型定义。

### [P2] 实例锁存在潜在竞态条件
- 文件: `src/machine-lock.ts:32`
- 类型: 鲁棒性 / 错误处理
- 现象: `acquireLock` 逻辑先通过 `isProcessAlive(pid)` 检查旧 PID，然后再执行 `writeFile`。
- 影响: 在并发启动的极短瞬间，两个进程可能同时发现旧进程已死并尝试写入自己的 PID。虽然概率较低，但在高并发或自动化脚本环境下可能失效。
- 建议: 考虑使用文件系统的独占写入（`x` flag）或专门的锁库来确保操作的原子性。

## 备注
- 本次评审仅基于静态代码分析，未进行动态运行测试。
- 前端 `web/src/` 部分未发现严重逻辑漏洞，但 SSE 连接的自动重连机制仍有待通过压力测试验证。
