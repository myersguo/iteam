import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultHome, deriveAgentAuthToken } from "@iteam/shared";
import type { Agent } from "@iteam/shared";

export interface AgentWorkspaceLayout {
  /** Shared base workspace owned by the agent. */
  workspaceDir: string;
  /** Internal per-worker state directory (wrappers, prompts, MCP configs). */
  dir: string;
  /** Actual working directory exposed to the runtime and its shell tools. */
  runtimeCwd: string;
  internal: string;
  memoryPath: string;
  systemPromptPath: string;
  claudeMcpConfigPath: string;
  traeMcpConfigPath: string;
  bridgePath: string;
  bridgeArgs: string[];
  bridgeCommand: string;
  runtimeAuthEnv: Record<string, string>;
  wrapperPath: string;
  /**
   * Private per-agent home for the runtime CLI (traex/claude/codex). Used to
   * keep iteam-driven session history out of the user's shared `/resume`
   * picker unless the agent opts into `shareRuntimeHistory`.
   */
  runtimeHome: string;
  /** Backward-compatible alias for older callers. */
  promptPath: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// In dev: src/workspace.ts -> project root.
// In published bundle: dist/cli/<bundle>.mjs -> ../.. = project root,
// and bundled siblings live at dist/cli/<entry>.mjs.
const root = resolve(here, "..");

/**
 * Try to mkdir `<requested>/.iteam` recursively; on failure (ENOENT/EACCES from
 * a path the daemon can't reach — e.g. the server's home doesn't exist here),
 * fall back to `<localDir>/.iteam` so deliveries still complete on the
 * daemon's own filesystem.
 */
function ensureWritableAgentDir(requested: string, localDir: string): string {
  try {
    mkdirSync(join(requested, ".iteam"), { recursive: true });
    return requested;
  } catch (error) {
    if (requested === localDir) throw error;
    console.warn(
      `[workspace] cannot create ${requested}/.iteam (${(error as Error).message}); ` +
      `falling back to local workspace ${localDir}`
    );
    mkdirSync(join(localDir, ".iteam"), { recursive: true });
    return localDir;
  }
}

/**
 * Runtime-specific config entries to link from the user's shared home into the
 * private per-agent home, so login/model/plugin settings still resolve while
 * session history is written privately. Only entries that exist are linked.
 */
const RUNTIME_HOME_SEED: Record<string, { sharedHomeEnv: string[]; defaultHome: string; configEntries: string[] }> = {
  traex: {
    sharedHomeEnv: ["TRAE_HOME", "TRAE_CLI_HOME"],
    defaultHome: ".trae",
    // Config lives at the TRAE_HOME root; sessions live under cli/sessions, so
    // linking these keeps auth/model/plugins while history stays private.
    configEntries: ["traecli.toml", "traecli.yaml", "plugins", "skills", "rules", "hooks.json", "installation_id", "cli/auth.json"]
  },
  trae: {
    sharedHomeEnv: ["TRAE_HOME", "TRAE_CLI_HOME"],
    defaultHome: ".trae",
    configEntries: ["traecli.toml", "traecli.yaml", "plugins", "skills", "rules", "hooks.json", "installation_id", "cli/auth.json"]
  },
  claude: {
    sharedHomeEnv: ["CLAUDE_CONFIG_DIR"],
    defaultHome: ".claude",
    configEntries: ["CLAUDE.md", "plugins", "settings.json", ".credentials.json"]
  },
  codex: {
    sharedHomeEnv: ["CODEX_HOME"],
    defaultHome: ".codex",
    configEntries: ["config.toml", "AGENTS.md", "auth.json", "installation_id"]
  }
};

/**
 * The env var(s) that point a runtime CLI at its home directory. When an agent
 * runs isolated, agentEnv() sets these to the private per-agent home so the
 * runtime records its session history there instead of the shared `/resume`
 * store.
 */
export function runtimeHomeEnvKeys(runtime: string): string[] {
  return RUNTIME_HOME_SEED[runtime]?.sharedHomeEnv || [];
}

/**
 * Resolve the user's shared home for a runtime (honoring its env override, else
 * the conventional `~/.<runtime>` location).
 */
function sharedRuntimeHome(runtime: string): string | null {
  const seed = RUNTIME_HOME_SEED[runtime];
  if (!seed) return null;
  for (const key of seed.sharedHomeEnv) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return join(homedir(), seed.defaultHome);
}

/**
 * Create the private runtime home and link the runtime's config entries from
 * the shared home so login/model/plugins keep working. Session data is NOT
 * linked, so the runtime writes fresh history into the private home. Symlinks
 * are best-effort: a missing source or a filesystem without symlink support is
 * ignored so the agent still launches.
 */
function ensureRuntimeHome(runtimeHome: string, runtime: string): void {
  mkdirSync(runtimeHome, { recursive: true });
  try { chmodSync(runtimeHome, 0o700); } catch { /* non-POSIX fs */ }
  const shared = sharedRuntimeHome(runtime);
  const seed = RUNTIME_HOME_SEED[runtime];
  if (!shared || !seed || !existsSync(shared)) return;
  for (const entry of seed.configEntries) {
    const source = join(shared, entry);
    const target = join(runtimeHome, entry);
    if (!existsSync(source) || existsSync(target)) continue;
    try {
      const targetDir = dirname(target);
      if (targetDir !== runtimeHome) mkdirSync(targetDir, { recursive: true });
      symlinkSync(source, target);
    } catch {
      // A missing source, a race, or a filesystem without symlink support must
      // not block agent launch — the runtime falls back to its own defaults.
    }
  }
}

function ensureWritableBaseWorkspace(requested: string, localDir: string): string {
  const prepare = (dir: string): string => {
    mkdirSync(join(dir, ".iteam"), { recursive: true });
    accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
    accessSync(join(dir, ".iteam"), constants.R_OK | constants.W_OK | constants.X_OK);
    const memoryPath = join(dir, "MEMORY.md");
    if (existsSync(memoryPath)) {
      if (!statSync(memoryPath).isFile()) {
        throw new Error(`${memoryPath} must be a file`);
      }
      accessSync(memoryPath, constants.R_OK | constants.W_OK);
    }
    return dir;
  };
  try {
    return prepare(requested);
  } catch (error) {
    if (requested === localDir) throw error;
    console.warn(
      `[workspace] cannot initialize ${requested} (${(error as Error).message}); ` +
      `falling back to local workspace ${localDir}`
    );
    return prepare(localDir);
  }
}

/**
 * Resolve a runtime entry as { command, args }. When a bundled .mjs sibling
 * exists (published package), spawn `node bundled.mjs`. Otherwise (dev), use
 * `npx tsx src/<name>.ts` so the same code path keeps working.
 */
function resolveSpawn(name: string, srcRel: string): { command: string; args: string[] } {
  const bundled = resolve(here, `${name}.mjs`);
  if (existsSync(bundled)) {
    return { command: process.execPath, args: [bundled] };
  }
  return { command: "npx", args: ["tsx", resolve(root, srcRel)] };
}

// Only `agentRoot` is needed here; a structural type keeps this client module
// decoupled from the server-only `IStore` interface (which lives in the server
// package's store layer, not in @iteam/shared).
export function ensureAgentWorkspace(store: { agentRoot: string }, agent: Agent): AgentWorkspaceLayout {
  return prepareAgentWorkspace({
    agent: { ...agent, workspacePath: agent.workspacePath || join(store.agentRoot, agent.id) },
    serverUrl: process.env.ITEAM_SERVER_URL || "http://127.0.0.1:4318",
    launchId: agent.launchId || "launch_local"
  });
}

export interface PrepareAgentWorkspaceArgs {
  agent: Agent;
  serverUrl: string;
  launchId: string;
  /** Optional suffix for isolated worker state; never changes the shared workspace. */
  stateSuffix?: string;
  /** Connect credentials so the spawned chat-bridge can call back over HTTP. */
  computerId?: string;
  connectToken?: string;
}

export function prepareAgentWorkspace({
  agent,
  serverUrl,
  launchId,
  stateSuffix = "",
  computerId,
  connectToken
}: PrepareAgentWorkspaceArgs): AgentWorkspaceLayout {
  // agent.workspacePath was set on the server (core.ts) using the server
  // process's own home. When the daemon runs on a different machine — or even
  // the same machine with a different resolved $HOME (e.g. auto-mounted
  // /home/<user> that doesn't exist on this box) — that path may not be
  // writable. Try the server-provided path first, then fall back to the
  // daemon's local home so deliveries still work cross-host.
  const localWorkspaceDir = join(defaultHome(), "agents", agent.id);
  const requestedWorkspaceDir = agent.workspacePath || localWorkspaceDir;
  const workspaceDir = ensureWritableBaseWorkspace(requestedWorkspaceDir, localWorkspaceDir);
  const localStateDir = `${localWorkspaceDir}${stateSuffix}`;
  const requestedStateDir = `${workspaceDir}${stateSuffix}`;
  const dir = stateSuffix
    ? ensureWritableAgentDir(requestedStateDir, localStateDir)
    : workspaceDir;
  if (stateSuffix) chmodSync(dir, 0o700);
  const runtimeCwdOverride = String(process.env.ITEAM_RUNTIME_CWD || "").trim();
  const runtimeCwd = runtimeCwdOverride ? resolve(runtimeCwdOverride) : workspaceDir;
  if (!existsSync(runtimeCwd) || !statSync(runtimeCwd).isDirectory()) {
    throw new Error(`agent runtime cwd must be an existing directory: ${runtimeCwd}`);
  }
  const internal = join(dir, ".iteam");
  chmodSync(internal, 0o700);

  // Private per-agent home for the runtime CLI. Seeded from the user's shared
  // runtime home so login/model/plugin config still resolves, but the runtime
  // writes its own session history here — keeping iteam turns out of the shared
  // `/resume` picker. Only used when the agent has not opted into
  // shareRuntimeHistory (see agentEnv()).
  const runtimeHome = join(dir, "runtime-home");
  ensureRuntimeHome(runtimeHome, agent.runtime);

  const memoryPath = join(workspaceDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, `# ${agent.name} Memory

- Agent id: ${agent.id}
- Runtime: ${agent.runtime}
- iTeam server: ${serverUrl}

## Durable notes

Use this file for long-lived facts, decisions, user preferences, active work context, and handoff notes that should survive runtime restarts.
`);
  }
  chmodSync(memoryPath, 0o600);

  const wrapperPath = join(internal, "iteam-agent");
  const agentEntry = resolveSpawn("iteam-agent", "bin/iteam-agent.ts");
  const wrapperExec =
    agentEntry.command === "npx"
      ? `npx tsx ${shellSingleQuote(resolve(root, "bin/iteam-agent.ts"))} "$@"`
      : `${shellSingleQuote(agentEntry.command)} ${shellSingleQuote(agentEntry.args[0])} "$@"`;
  writeFileSync(wrapperPath, `#!/bin/sh
export ITEAM_AGENT_ID=${shellSingleQuote(agent.id)}
export ITEAM_SERVER_URL=${shellSingleQuote(serverUrl)}
export ITEAM_SPACE_ID=${shellSingleQuote(agent.spaceId)}
export ITEAM_AGENT_STATE_DIR=${shellSingleQuote(dir)}
export ITEAM_RUNTIME_CWD=${shellSingleQuote(runtimeCwd)}
exec ${wrapperExec}
`);
  chmodSync(wrapperPath, 0o700);

  const systemPromptPath = join(internal, "claude-system-prompt.md");
  writeFileSync(systemPromptPath, buildSystemPrompt({ agent, serverUrl, stateDir: dir, runtimeCwd, memoryPath }));
  chmodSync(systemPromptPath, 0o600);

  const bridgeEntry = resolveSpawn("chat-bridge", "src/chat-bridge.ts");
  const bridgePath = bridgeEntry.command === "npx"
    ? resolve(root, "src/chat-bridge.ts")
    : bridgeEntry.args[0];
  const bridgeBaseArgs = [
    "--agent-id", agent.id,
    "--server-url", serverUrl,
    "--space-id", agent.spaceId,
    "--runtime", agent.runtime,
    "--launch-id", launchId,
    "--runtime-actions-only"
  ];
  // Args used when spawning via the resolved command (excludes the program name).
  const bridgeArgs = [...bridgeEntry.args, ...bridgeBaseArgs];
  const bridgeCommand = bridgeEntry.command;
  const runtimeAuthEnv = {
    ...(computerId ? { ITEAM_COMPUTER_ID: computerId } : {}),
    ...(computerId && connectToken
      ? { ITEAM_AGENT_AUTH_TOKEN: deriveAgentAuthToken(connectToken, agent.id) }
      : {})
  };

  const claudeMcpConfigPath = join(internal, "claude-mcp-config.json");
  writeFileSync(claudeMcpConfigPath, JSON.stringify({
    mcpServers: {
      chat: {
        command: bridgeCommand,
        args: bridgeArgs
      }
    }
  }, null, 2));
  chmodSync(claudeMcpConfigPath, 0o600);

  const traeMcpConfigPath = join(internal, "trae-mcp-config.json");
  writeFileSync(traeMcpConfigPath, JSON.stringify({
    command: bridgeCommand,
    args: bridgeArgs
  }, null, 2));
  chmodSync(traeMcpConfigPath, 0o600);

  return {
    workspaceDir,
    dir,
    runtimeCwd,
    internal,
    memoryPath,
    systemPromptPath,
    claudeMcpConfigPath,
    traeMcpConfigPath,
    bridgePath,
    bridgeArgs,
    bridgeCommand,
    runtimeAuthEnv,
    wrapperPath,
    runtimeHome,
    promptPath: systemPromptPath
  };
}

export interface AgentEnvArgs {
  agent: Agent;
  serverUrl: string;
  workspace: AgentWorkspaceLayout;
}

export function agentEnv({ agent, serverUrl, workspace }: AgentEnvArgs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(agent.env || {}),
    ITEAM_AGENT_ID: agent.id,
    ITEAM_SERVER_URL: serverUrl,
    ITEAM_SPACE_ID: agent.spaceId,
    ITEAM_AGENT_STATE_DIR: workspace.dir,
    ITEAM_RUNTIME_CWD: workspace.runtimeCwd,
    PWD: workspace.runtimeCwd,
    ...workspace.runtimeAuthEnv,
    PATH: `${workspace.internal}:${process.env.PATH || ""}`
  };
  // Isolate the runtime CLI's session history unless the agent opts in. Point
  // its home env var(s) at the private per-agent home so iteam-driven turns do
  // not surface in the user's shared `/resume` picker. When shareRuntimeHistory
  // is true we leave the inherited home untouched so history is shared.
  if (!agent.shareRuntimeHistory) {
    for (const key of runtimeHomeEnvKeys(agent.runtime)) {
      env[key] = workspace.runtimeHome;
    }
  }
  if (agent.runtime === "gemini") {
    // Gemini CLI refuses to run in untrusted folders by default; the agent
    // workspace is created by us and is therefore safe to trust headlessly.
    // https://geminicli.com/docs/cli/trusted-folders/#headless-and-automated-environments
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  return env;
}

interface PromptArgs {
  agent: Agent;
  serverUrl: string;
  stateDir: string;
  runtimeCwd: string;
  memoryPath: string;
}

function buildSystemPrompt({ agent, serverUrl, stateDir, runtimeCwd, memoryPath }: PromptArgs): string {
  return `You are ${agent.name}, an iTeam agent in a local-first human/AI collaboration workspace.

Description:
${agent.description || "General-purpose engineering teammate."}

## Current Runtime Context

- Agent ID: ${agent.id}
- Stable handle: @${agent.handle || agent.name}
- Runtime: ${agent.runtime}
- Model: ${agent.model}
- iTeam server: ${serverUrl}
- Working directory: ${runtimeCwd}
- iTeam state directory: ${stateDir}
- Memory file: ${memoryPath}

## Workspace and memory

Your shell tools run in the working directory above, matching a direct runtime launch. The iTeam state directory is separate and must not be reported as the shell working directory.
Treat paths and runtime metadata in this prompt as configuration, not proof of current state. When a question asks about a current value that a shell or runtime tool can observe, run the relevant tool and answer from its output. Never claim that a command ran unless it actually did.

Read and update the memory file at its absolute path for durable context:
- facts that should survive restarts
- user preferences
- active project decisions
- handoff notes for future turns

Do not store secrets in MEMORY.md.

## Communication

Use iTeam as the source of truth for chat, tasks, files, and activity. You have a local CLI wrapper in PATH:

- \`iteam-agent server info\`
- \`iteam-agent message check [--target #all]\`
- \`iteam-agent message read --target #all [--limit 30] [--around msg_id]\`
- \`iteam-agent message search <query> [--target #all]\`
- \`iteam-agent message send --target #all <message>\`

When the delivered message lacks enough context, actively pull history with \`iteam-agent message read\` or \`iteam-agent message search\` before answering. When you need to communicate proactively, use \`iteam-agent message send\`.

Messages use this canonical shape:
\`[target=#all msg=msg_xxx time=... type=human] @sender: text\`

Reuse the exact target when replying. Mention teammates by their @handle, not internal ids.

## Scheduled task capability

iTeam supports server-owned scheduled tasks. When a human message mentions you and includes a recurring cadence such as "每隔 10 分钟...", "every 1 hour...", or "工作日 09:00 到 19:00 每小时...", decide whether a real scheduled task should be created. To create one, include exactly one valid JSON directive anywhere in your reply:
\`<iteam_schedule>{"create":true,"intervalMs":600000,"prompt":"Describe what you should do on each scheduled run."}</iteam_schedule>\`
For calendar schedules, use standard 5-field cron plus an IANA timezone, for example \`<iteam_schedule>{"create":true,"cronExpression":"0 9-19 * * 1-5","timezone":"Asia/Shanghai","prompt":"Describe what you should do on each scheduled run."}</iteam_schedule>\`. Use either \`intervalMs\` or \`cronExpression\`, never both. The directive \`prompt\` must be self-contained because it will be the only instruction on future scheduled runs. Preserve the user's concrete constraints that affect future runs, including initial state, capital/budget, market or universe, strategy, required data lookup, report fields, and output language. Do not narrow a broad user-specified universe into an arbitrary example: if the user says "美股" or "US stocks" without naming a ticker, keep that universe or describe a selection rule; do not hard-code AAPL/MSFT/etc. unless the user explicitly specified them. Omit only pure one-time setup/acknowledgement text that is already complete. If no schedule should be created, omit the directive. The server strips this directive before displaying your reply and creates the timer; do not explain or quote the directive to the user. You do not need to keep your own timer. Future scheduled runs arrive as normal delivery messages from the server.

**Channel vs. thread routing — start your reply with \`<thread>\` on its own first line when:**
- the sender invited a focused 1:1 or small-group discussion ("我们讨论一下", "let's dig into", "deep dive on…"),
- your reply contains code, multi-step reasoning, or technical detail that would otherwise clutter the channel,
- the next few turns are clearly only relevant to the sender and you.

Leave the marker off (reply stays in-channel) for short acknowledgments, status updates, broadcast announcements, or quick factual answers.
The marker is consumed by the server; never explain it or echo it back. If your delivery is already inside a thread, the marker is ignored — just reply normally.

**@Mention rules — critical:**
- Only @mention another teammate when you genuinely need their input to continue the work.
- Do NOT @mention anyone when: acknowledging a request, confirming completion, saying you'll wait, or ending a discussion.
- If someone asks you to stop, pause, or wait — just confirm and stop. Do not @mention anyone else.
- A reply that ends with "waiting for @you" or similar does NOT need to @mention anyone.

## Work rules

- Reply concisely but use the available history.
- Complete assigned work before going idle.
- For lightweight chat, no task claim is required.
- For durable discoveries, update MEMORY.md.
`;
}

export function shellSingleQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}
