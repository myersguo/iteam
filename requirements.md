# iTeam 需求与方向调研

> 生成日期: 2026-06-26  
> 调研者: research subagent  
> 当前版本快照: feature_agents_daily_vv2 (基于 03a6ecb, v0.1.39)

## 1. 行业现状速读

- **MCP 协议标准化与 UI 扩展**：MCP 已成为 AI 工具集成的行业标准，2026 年路线图重点转向"MCP Apps"，支持服务器渲染的 UI 组件直接在聊天界面渲染。
- **并行 Agent 编排成为性能瓶颈突破口**：在多 Agent 工作流中，Fan-Out（并行执行）被视为最大的性能优化手段，领先工具如 Conductor 已支持多 Agent 在独立 Git 工作树中并行运行。
- **"人机回环 (HOTL)"需求凸显**：针对高风险决策，业界最佳实践是在工作流中插入"审批点"，防止 Agent 自主执行破坏性操作。
- **端侧/本地优先趋势**：由于隐私和延迟需求，AI 助理正大规模转向本地运行，强调"代码属于开发者"，不上传敏感数据到云端。
- **AI 编码 Agent 的主要缺陷**：功能性 Bug（占 67%）多源于配置、集成错误及对多文件联动重构的逻辑缺失。

## 2. iteam 现有能力盘点

- **核心能力：本地优先的多 Agent 协作**：支持 Codex/Claude/Gemini/Trae 等主流 CLI Agent 的统一调度。
- **核心能力：多机协同架构**：通过 connect-token 实现跨机器的 Agent 分发与消息投递。
- **核心能力：任务看板集成**：内置 todo/in_progress/in_review/done 状态管理，支持任务与线程关联。
- **核心能力：MCP 协议桥接**：为 Agent 提供内置的 `iteam_message_*` 工具，具备基础上下文感知能力。
- **核心能力：编辑式 Web UI**：采用奶油色画布+珊瑚色强调的高质量视觉系统。
- **核心能力：ACP 协议支持**：已实现 AcpDriver，支持 Trae/Codex 等的 ACP 模式长连接。
- **核心能力：定时任务**：支持 cron 表达式和 interval 两种定时调度方式。
- **核心能力：飞书/Lark 集成**：支持 Lark Bot 长连接模式，外部消息双向同步。
- **核心能力：SSE 推送**：已实现 Computer Push 机制，替代轮询实现实时命令下发。
- **缺口：缺乏结构化审批流**：聊天/任务模型尚不支持 Agent 在执行关键操作前强制请求人类确认。
- **缺口：UI 组件扩展性不足**：仅支持文本输出，无法渲染 MCP 服务器返回的交互式 UI。
- **缺口：并发执行冲突**：未在设计中明确多个 Agent 同时修改本地文件时的隔离方案。
- **缺口：分布式监控薄弱**：缺乏各节点健康度感知与任务自动漂移能力。

## 3. 需求条目

### [优先级 P0] 人机回环 (Human-on-the-Loop) 审批流
- **背景与痛点**: Agent 在执行文件删除、代码推送或高额 Token 消耗任务时，若无人类确认可能造成不可逆损失。
- **用户故事**: As a developer, I want my agent to pause and ask for my explicit approval before it pushes code to production, so that I can prevent accidental breakages.
- **关键能力点**: 在消息模型中引入 `pending_approval` 状态；Web UI 支持按钮交互反馈；Agent 可通过 MCP 工具 `wait_for_approval` 挂起。
- **验收标准**: Agent 发起审批请求时，聊天界面显示"待审批"卡片；用户点击"同意"或"拒绝"后，Agent 能接收到对应信号继续或终止。
- **涉及模块**: `src/types.ts`, `src/chat-bridge.ts`, `web/src/App.tsx`
- **风险与依赖**: 需要在后端维护挂起的异步状态，超时处理机制必不可少。

### [优先级 P1] 独立 Git Worktree 并行执行隔离
- **背景与痛点**: 多个 Agent 同时在一个工程内并行修改文件会产生 Race Condition。
- **用户故事**: As a team lead, I want to assign task A to Agent 1 and task B to Agent 2 simultaneously, so that they can work in independent git worktrees.
- **关键能力点**: 自动为每个任务线程创建临时 Git Worktree；任务完成后自动合并或提供 Diff 预览。
- **验收标准**: 支持"并行运行"模式，不同 Agent 对应不同的磁盘工作路径；界面提供跨 Worktree 的 Diff 对比。
- **涉及模块**: `src/workspace.ts`, `src/agent-launcher.ts`
- **风险与依赖**: 本地磁盘占用可能激增；Git 工作流需要高度自动化。

### [优先级 P1] API 鉴权框架
- **背景与痛点**: 当前几乎所有 API 端点均无鉴权，在公网部署场景下极不安全。
- **用户故事**: As an ops engineer, I want all API endpoints to require authentication, so that unauthorized users cannot control my agents or read my data.
- **关键能力点**: 引入统一的鉴权中间件；为每个 API 端点标注所需的权限级别；支持 Bearer Token 或 API Key 模式。
- **验收标准**: 未携带有效凭证的请求返回 401；权限不足返回 403；现有 CLI 行为不受影响。
- **涉及模块**: `src/http-server.ts`, `src/core.ts`
- **风险与依赖**: 需要处理 CLI 工具的 Token 传递问题；向后兼容是关键。

### [优先级 P2] 语义化上下文剪枝 (Task-aware Context)
- **背景与痛点**: 随着会话增长，Agent 每次通过 MCP 读取全部历史会消耗大量 Token 且引入噪声。
- **用户故事**: As a developer, I want the agent to only see messages relevant to the current Task thread, so that it can reason more accurately.
- **关键能力点**: 基于语义聚类过滤非相关上下文；提供"上下文针脚"功能。
- **验收标准**: Token 消耗降低 30% 以上。
- **涉及模块**: `src/chat-bridge.ts`, `src/store/base.ts`

### [优先级 P2] Store 层写放大优化
- **背景与痛点**: `BaseStore.emit` 每次事件都触发全量 `persist`，与 `mutate` 的 persist 形成双重写入。
- **用户故事**: As a developer, I want the store to batch writes efficiently, so that high-frequency SSE events don't cause excessive disk IO.
- **关键能力点**: 引入脏标记 + debounce 机制，由 mutate 统一刷盘。
- **验收标准**: 高频事件场景下 persist 调用次数降低 80% 以上。
- **涉及模块**: `src/store/base.ts`

## 4. 不在本次范围

- **云端中心化存储**：坚持 Local-first 原则。
- **Agent 模型训练/微调**：项目专注于"编排"而非"建模"。
- **手机原生 App 开发**：优先打磨 Web UI 的移动端响应式。

## 5. 关键不确定项

- **API 鉴权与现有 CLI 的兼容性**：如何在不破坏现有 CLI 使用体验的前提下引入鉴权？
- **Git Worktree 在局域网外的性能表现**：跨机器分配任务涉及大量代码同步时如何保证效率？
- **审批流的超时策略**：Agent 等待审批时的超时时间如何合理配置？
- **写放大优化的副作用**：debounce 可能导致进程崩溃时丢失最近的若干事件，需要权衡。
