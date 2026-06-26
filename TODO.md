# iTeam 每日 TODO — 2026-06-26

> 来源: 综合 `issue.md` 与 `requirements.md` 的当日可落地子集  
> 分支: feature_agents_daily_vv2  
> 范围限定: 单日可完成；优先安全/稳定性硬伤，避免大型架构改动

## 选题逻辑（简短）
- P0（API 鉴权 / 全量状态泄露）需要全局改造，单日落地风险高，今日不动。
- 选择 P1 中两项**改动局部、可单元验证**的安全/稳定性修复，其余 issue 留待后续每日推进。
- `requirements.md` 中的需求（HOTL 审批、Git Worktree、API 鉴权）均为多日工程，今日不开新坑。

## 今日 TODO

### [TODO-1] 修复运行时 Argument 注入漏洞
- **来源**: `issue.md` → P1 「运行时 Argument 注入漏洞」
- **目标文件**: `src/runtime/profiles.ts`（opencode profile）与 `src/runtime/oneshot-driver.ts`（codex / traecli 路径）
- **要求**:
  - 在 `profiles.ts` 的 opencode profile 中，将 `args: ["run", "{{prompt}}"]` 改为 `args: ["run", "--", "{{prompt}}"]`，确保 prompt 不会被 opencode CLI 解析为选项。
  - 在 `oneshot-driver.ts` 的 `buildOneShotSpec` 中，codex 路径在 prompt 前插入 `"--"`；traecli 路径同样在 prompt 前插入 `"--"`。
  - 不改变 spawn 调用方式（已经是数组参数，安全），仅添加 `--` 终止符防止目标 CLI 误解析 prompt 内容。
- **验收**:
  - `npx tsc --noEmit` 通过。
  - 若 prompt 包含 `--version` 等字符串，CLI 不会将其误认为参数。
- **不要做**:
  - 不要改变 spawn 为 exec / shell 模式。
  - 不要重构 profile 渲染逻辑。

### [TODO-2] 修复实例锁潜在竞态条件
- **来源**: `issue.md` → P1 「实例锁存在潜在竞态条件」
- **目标文件**: `src/machine-lock.ts`（`acquireLock` 函数）
- **要求**:
  - 将 `await writeFile(options.lockPath, ...)` 改为先写入临时文件 `options.lockPath.tmp.<pid>`，再 `rename(temp, options.lockPath)`。
  - 出错时清理临时文件，向上抛错。
  - 保持异步语义不变（使用 `fs/promises` 的 `rename`）。
- **验收**:
  - 并发调用 `acquireLock` 不会导致多进程同时写入并获得锁。
  - 现有调用方行为不变。
- **不要做**:
  - 不引入新 npm 依赖。
  - 不改变锁的释放逻辑。

## 提交策略
- 单次 commit，message 模板：
  `feat(security,lock): fix arg injection + lock race condition (daily-2026-06-26)`
- 仅修改 `src/runtime/profiles.ts`、`src/runtime/oneshot-driver.ts`、`src/machine-lock.ts`。
- 不要修改 `package.json` / lockfile / 其他无关文件。

## 完成回执
实现完成后请回报：
1. 实际修改的文件列表与每个文件的 `git diff --stat`。
2. 是否运行了 `npx tsc --noEmit`，结果如何。
3. 主要决策点与未解决疑问（如有）。
