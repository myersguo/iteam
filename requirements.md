# iTeam 需求与方向调研

> 生成日期: 2026-06-25  
> 调研者: research subagent  
> 当前版本快照: feature_agents_daily

## 1. 行业现状速读

- **MCP 协议标准化与 UI 扩展**：MCP 已成为 AI 工具集成的行业标准，2026 年路线图重点转向"MCP Apps"，支持服务器渲染的 UI 组件（如仪表盘、表单）直接在聊天界面渲染 [来源](https://blog.modelcontextprotocol.io/posts/2026-05-21-release-candidate/)（事实）。
- **并行 Agent 编排成为性能瓶颈突破口**：在多 Agent 工作流中，Fan-Out（并行执行）被视为最大的性能优化手段，领先工具如 Conductor 已支持多 Agent 在独立 Git 工作树中并行运行 [来源](https://addyosmani.com/blog/code-agent-orchestra/)（事实）。
- **"人机回环 (HOTL)"需求凸显**：针对高风险决策，业界最佳实践是在工作流中插入"审批点"，防止 Agent 自主执行破坏性操作 [来源](https://fast.io/resources/ai-agent-swarm-orchestration/)（推断）。
- **端侧/本地优先趋势**：由于隐私和延迟需求，2026 年 AI 助理正大规模转向本地运行，强调"代码属于开发者"，不上传敏感数据到云端 [来源](https://veb-dev.com/en/blog/ai-agents-claude-vs-codex-2026/)（事实）。
- **分布式协作的可靠性挑战**：多设备环境下的 Agent 调度面临非平稳环境（Non-stationarity）和状态同步挑战，健康监控与自动切换成为分布式系统的核心基础设施 [来源](https://pilotprotocol.network/blog/autonomous-agent-networking-distributed-ai)（事实）。
- **AI 编码 Agent 的主要缺陷**：功能性 Bug（占 67%）多源于配置、集成错误及对多文件联动重构的逻辑缺失 [来源](https://www.eecs.yorku.ca/~wangsong/papers/fse26-industry.pdf)（事实）。

## 2. iteam 现有能力盘点

- **核心能力：本地优先的多 Agent 协作**：支持 Codex/Claude/Gemini 等主流 CLI Agent 的统一调度。
- **核心能力：多机协同架构**：通过 connect-token 实现跨机器的 Agent 分发与消息投递。
- **核心能力：任务看板集成**：内置 todo/in_progress/done 状态管理，支持任务与线程关联。
- **核心能力：MCP 协议桥接**：为 Agent 提供内置的 `iteam_message_*` 工具，具备基础上下文感知能力。
- **核心能力：编辑式 Web UI**：采用奶油色画布+珊瑚色强调的高质量视觉系统。
- **缺口：缺乏结构化审批流**：目前的聊天/任务模型尚不支持 Agent 在执行关键操作前强制请求人类确认。
- **缺口：UI 组件扩展性不足**：仅支持文本输出，无法渲染 MCP 服务器返回的交互式 UI（MCP Apps）。
- **缺口：并发执行冲突**：未在设计中明确多个 Agent 同时修改本地文件时的隔离方案（如 Git Worktrees）。
- **缺口：分布式监控薄弱**：虽然支持多机连接，但缺乏各节点健康度感知与任务自动漂移能力。
- **缺口：上下文治理精度**：Agent 通过 MCP 读取消息的逻辑较为通用，缺乏针对复杂多步推理的任务上下文剪枝。

## 3. 需求条目

### [优先级 P0] 人机回环 (Human-on-the-Loop) 审批流
- **背景与痛点**: Agent 在执行文件删除、代码推送或高额 Token 消耗任务时，若无人类确认可能造成不可逆损失。目前 iteam 仅通过聊天互动，无法强制阻塞执行。
- **用户故事**: As a developer, I want my agent to pause and ask for my explicit approval in a structured UI before it pushes code to production, so that I can prevent accidental breakages.
- **关键能力点**: 在消息模型中引入 `pending_approval` 状态；Web UI 支持按钮交互反馈；Agent 可通过 MCP 工具 `wait_for_approval` 挂起。
- **验收标准**: 
  - Agent 发起审批请求时，聊天界面显示"待审批"卡片。
  - 用户点击"同意"或"拒绝"后，Agent 能接收到对应的信号继续或终止任务。
  - 任务看板自动记录审批历史。
- **涉及模块**: `src/types.ts`, `src/chat-bridge.ts`, `web/src/App.tsx`
- **风险与依赖**: 需要在后端维护挂起的异步状态，超时处理机制必不可少。
- **参考 / 启发来源**: [Fastio AI Agent Swarm Best Practices](https://fast.io/resources/ai-agent-swarm-orchestration/)

### [优先级 P1] MCP Apps (Interactive UI) 渲染支持
- **背景与痛点**: 2026 年 MCP 协议引入了 UI 扩展，Agent 返回的数据不仅是文本，还包含图表、表单等。目前 iteam Web UI 无法渲染这些富交互内容。
- **用户故事**: As a researcher, I want my agent to display a data visualization chart directly in the chat when analyzing logs, so that I don't have to look at raw JSON logs.
- **关键能力点**: 实现 MCP Apps 渲染引擎；支持标准 UI Schema 映射；建立 Web UI 与本地 MCP Server 的双向事件通信。
- **验收标准**: 
  - Web UI 能根据 MCP 返回的 `content-type: application/vnd.mcp.app+json` 渲染动态组件。
  - 用户在 UI 组件上的操作（如提交表单）能通过 MCP 事件传回给 Agent。
- **涉及模块**: `web/src/App.tsx`, `src/runtime/acp-driver.ts`
- **风险与依赖**: 前端动态渲染存在安全风险，需要沙箱环境或白名单机制。
- **参考 / 启发来源**: [MCP 2026 Roadmap](https://blog.modelcontextprotocol.io/posts/2026-05-21-release-candidate/)

### [优先级 P1] 独立 Git Worktree 并行执行隔离
- **背景与痛点**: 多个 Agent（如 Codex 和 Claude）同时在一个工程内并行修改文件会产生 Race Condition。这是多 Agent 协作的主要痛点。
- **用户故事**: As a team lead, I want to assign task A to Agent 1 and task B to Agent 2 simultaneously, so that they can work in independent git worktrees without corrupting my current staging area.
- **关键能力点**: 自动为每个任务线程创建临时 Git Worktree；任务完成后自动合并或提供 Diff 预览；管理 Worktree 的生命周期。
- **验收标准**: 
  - 支持"并行运行"模式，不同 Agent 对应不同的磁盘工作路径。
  - 界面提供跨 Worktree 的 Diff 对比。
- **涉及模块**: `src/workspace.ts`, `src/agent-launcher.ts`
- **风险与依赖**: 本地磁盘占用可能激增；Git 工作流需要高度自动化以处理冲突。
- **参考 / 启发来源**: [Addy Osmani: The Code Agent Orchestra](https://addyosmani.com/blog/code-agent-orchestra/)

### [优先级 P2] 多机分布式健康监控与自动重连
- **背景与痛点**: `iteam connect` 连接的副机可能因休眠、断网失效，目前系统对副机状态感知滞后，任务分配到离线机器会导致挂死。
- **用户故事**: As a user with multiple computers, I want the system to automatically move my background research agents to another online computer if my laptop goes offline, so that my long-running tasks are not interrupted.
- **关键能力点**: 引入基于 SSE/WebSocket 的心跳监测；副机状态看板；任务重路由逻辑。
- **验收标准**: 
  - 计算机列表中实时显示节点在线/离线状态。
  - 节点掉线时，该节点上的未完成任务自动标记为 `failed_and_retryable` 或转移至可用节点。
- **涉及模块**: `src/server.ts`, `src/agent-daemon.ts`, `web/src/App.tsx`
- **风险与依赖**: 状态强一致性在分布式环境下难以保证，需要权衡延迟与可靠性。
- **参考 / 启发来源**: [Pilot Protocol: Distributed AI Networking](https://pilotprotocol.network/blog/autonomous-agent-networking-distributed-ai)

### [优先级 P2] 语义化上下文剪枝 (Task-aware Context)
- **背景与痛点**: 随着会话增长，Agent 每次通过 MCP 读取全部历史会消耗大量 Token 且引入噪声。
- **用户故事**: As a developer, I want the agent to only see messages and files relevant to the current Task thread, so that it can reason more accurately without being distracted by irrelevant chat history.
- **关键能力点**: 基于 RAG 或语义聚类过滤非相关上下文；提供"上下文针脚"功能，允许用户手动标记重要消息。
- **验收标准**: 
  - 评估不同剪枝策略下的 Token 消耗降低 30% 以上。
  - Agent 在长会话中的任务成功率有显著提升。
- **涉及模块**: `src/chat-bridge.ts`, `src/store/base.ts`
- **风险与依赖**: 过度剪枝可能导致 Agent 丢失关键全局信息。
- **参考 / 启发来源**: [SITS2026 Agent 协作系统性能跃迁](https://blog.csdn.net/LiteCode/article/details/160107713)

## 4. 不在本次范围

- **云端中心化存储**：坚持 Local-first 原则，不考虑将 `state.json` 迁移至公共云。
- **Agent 模型训练/微调**：项目专注于"编排"而非"建模"，模型能力依赖上游（Anthropic/OpenAI）。
- **手机原生 App 开发**：优先打磨 Web UI 的移动端响应式，暂不启动 Native 项目。

## 5. 关键不确定项

- **MCP Apps 的安全性**：如何在本地 Web 环境中安全地渲染第三方 MCP 服务器提供的 UI 组件？
- **多机文件同步开销**：如果跨机器分配任务涉及大量代码同步（Git Worktree），在局域网外的性能表现如何？
- **数据库切换平滑度**：从默认的 JSON 存储平滑迁移到 MySQL/SQLite 时，如何保证用户数据的零损耗？
