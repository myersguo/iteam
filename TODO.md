# iTeam 每日 TODO — 2026-06-25

> 来源: 综合 `issue.md` 与 `requirements.md` 的当日可落地子集  
> 分支: feature_agents_daily_vv2  
> 范围限定: 单日可完成；优先安全/稳定性硬伤，避免大型架构改动

## 选题逻辑（简短）
- `issue.md` 中 P0（API 鉴权 / 全量状态泄露）需要全局改造，单日落地风险高，今日不动。
- 选择 P1 中两项**改动局部、可单元验证**的安全 / 持久化修复，其余 issue 留待后续每日推进。
- `requirements.md` 中的需求（HOTL 审批、Git Worktree、API 鉴权）均为多日工程，今日不开新坑。

## 今日 TODO

### [TODO-1] 修复 workspace.ts 生成的 wrapper 脚本中的 Shell 注入风险
- **来源**: `issue.md` → P1 「生成 Agent 脚本时的 Shell 注入风险」
- **目标文件**: `src/workspace.ts`（核心改动点位 ~L116，函数 `prepareAgentWorkspace`）
- **要求**:
  - 在生成 `iteam-agent` wrapper 脚本时，对所有外部传入的字符串变量（至少包括 `serverUrl`、`agentId`）做 POSIX shell 安全转义：使用单引号包裹 + `'\''` 转义内嵌单引号，写一个本地 helper `shellEscape(value: string): string`。
  - 保留原有行为：脚本仍以 `export VAR=...` 方式注入环境变量，不得改变 wrapper 的对外接口或路径。
  - 在文件顶部或函数注释里加 1 行说明："Shell-escape all interpolated values to prevent injection."
- **验收**:
  - `bash -n` 静态语法检查通过。
  - 若变量包含 `';rm -rf /;#`，转义后写入到脚本中的字面值仍是这串，不会被 shell 解释执行。
- **不要做**:
  - 不要重构 wrapper 模板格式或迁移到 JSON 配置。
  - 不要触碰 runtime profiles 的 argument injection。

### [TODO-2] `JsonStore.persist` 改为原子写入（temp file + rename）
- **来源**: `issue.md` → P1 「同步且非原子的状态持久化机制」
- **目标文件**: `src/store/json-store.ts`（`persist` / `writeFileSync` 调用点）
- **要求**:
  - 写入流程改为：
    1) 写入到同目录下的 `state.json.tmp.<pid>.<ts>`（同分区，保证 rename 原子）；
    2) `fs.renameSync(tmp, target)`；
    3) 出错时清理 tmp 文件，向上抛错。
  - 仍然保持同步语义（异步化与 debounce 是更大改造，今日不做，但在 `// TODO(perf):` 注释里登记一行）。
- **验收**:
  - 在写入过程中 kill -9 自身进程：原 `state.json` 仍可读、内容是上一版完整 JSON。
  - 现有调用方（`BaseStore.mutate`）行为不变，签名不变。
- **不要做**:
  - 不引入新 npm 依赖，用原生 `fs` 即可。
  - 不切换到异步 IO 或 debounce（留给后续）。

## 提交策略
- 单次 commit，message 模板：
  `feat(security,store): escape wrapper script vars + atomic JsonStore.persist (daily-2026-06-25)`
- 仅修改 `src/workspace.ts` 与 `src/store/json-store.ts`；新增 helper 文件 `src/utils/shell-escape.ts`。
- 不要修改 `package.json` / lockfile / 其他无关文件。

## 完成回执
实现 subagent 完成后请回报：
1. 实际修改的文件列表与每个文件的 `git diff --stat`。
2. 是否运行了 `tsc --noEmit` / `npm run build`，结果如何。
3. 主要决策点与未解决疑问（如有）。
