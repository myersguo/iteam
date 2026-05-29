import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHome } from "./lib.js";
import type { IStore } from "./store/types.js";
import type { Agent } from "./types.js";

export interface AgentWorkspaceLayout {
  dir: string;
  internal: string;
  memoryPath: string;
  systemPromptPath: string;
  claudeMcpConfigPath: string;
  traeMcpConfigPath: string;
  bridgePath: string;
  bridgeArgs: string[];
  bridgeCommand: string;
  wrapperPath: string;
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

export function ensureAgentWorkspace(store: IStore, agent: Agent): AgentWorkspaceLayout {
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
  /** Connect credentials so the spawned chat-bridge can call back over HTTP. */
  computerId?: string;
  connectToken?: string;
}

export function prepareAgentWorkspace({ agent, serverUrl, launchId, computerId, connectToken }: PrepareAgentWorkspaceArgs): AgentWorkspaceLayout {
  // agent.workspacePath was set on the server (core.ts) using the server
  // process's own home. When the daemon runs on a different machine — or even
  // the same machine with a different resolved $HOME (e.g. auto-mounted
  // /home/<user> that doesn't exist on this box) — that path may not be
  // writable. Try the server-provided path first, then fall back to the
  // daemon's local home so deliveries still work cross-host.
  const localDir = join(defaultHome(), "agents", agent.id);
  const requestedDir = agent.workspacePath || localDir;
  const dir = ensureWritableAgentDir(requestedDir, localDir);
  const internal = join(dir, ".iteam");

  const memoryPath = join(dir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, `# ${agent.name} Memory

- Agent id: ${agent.id}
- Runtime: ${agent.runtime}
- iTeam server: ${serverUrl}

## Durable notes

Use this file for long-lived facts, decisions, user preferences, active work context, and handoff notes that should survive runtime restarts.
`);
  }

  const wrapperPath = join(internal, "iteam-agent");
  const agentEntry = resolveSpawn("iteam-agent", "bin/iteam-agent.ts");
  const wrapperExec =
    agentEntry.command === "npx"
      ? `npx tsx "${resolve(root, "bin/iteam-agent.ts")}" "$@"`
      : `"${agentEntry.command}" "${agentEntry.args[0]}" "$@"`;
  writeFileSync(wrapperPath, `#!/bin/sh
export ITEAM_AGENT_ID="${agent.id}"
export ITEAM_SERVER_URL="${serverUrl}"
exec ${wrapperExec}
`);
  chmodSync(wrapperPath, 0o755);

  const systemPromptPath = join(internal, "claude-system-prompt.md");
  writeFileSync(systemPromptPath, buildSystemPrompt({ agent, serverUrl, dir }));

  const bridgeEntry = resolveSpawn("chat-bridge", "src/chat-bridge.ts");
  const bridgePath = bridgeEntry.command === "npx"
    ? resolve(root, "src/chat-bridge.ts")
    : bridgeEntry.args[0];
  const bridgeBaseArgs = [
    "--agent-id", agent.id,
    "--server-url", serverUrl,
    "--runtime", agent.runtime,
    "--launch-id", launchId,
    "--runtime-actions-only"
  ];
  if (computerId && connectToken) {
    bridgeBaseArgs.push("--computer-id", computerId, "--connect-token", connectToken);
  }
  // Args used when spawning via the resolved command (excludes the program name).
  const bridgeArgs = [...bridgeEntry.args, ...bridgeBaseArgs];
  const bridgeCommand = bridgeEntry.command;

  const claudeMcpConfigPath = join(internal, "claude-mcp-config.json");
  writeFileSync(claudeMcpConfigPath, JSON.stringify({
    mcpServers: {
      chat: {
        command: bridgeCommand,
        args: bridgeArgs
      }
    }
  }, null, 2));

  const traeMcpConfigPath = join(internal, "trae-mcp-config.json");
  writeFileSync(traeMcpConfigPath, JSON.stringify({
    command: bridgeCommand,
    args: bridgeArgs
  }, null, 2));

  return {
    dir,
    internal,
    memoryPath,
    systemPromptPath,
    claudeMcpConfigPath,
    traeMcpConfigPath,
    bridgePath,
    bridgeArgs,
    bridgeCommand,
    wrapperPath,
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
    PATH: `${workspace.internal}:${process.env.PATH || ""}`
  };
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
  dir: string;
}

function buildSystemPrompt({ agent, serverUrl, dir }: PromptArgs): string {
  return `You are ${agent.name}, an iTeam agent in a local-first human/AI collaboration workspace.

Description:
${agent.description || "General-purpose engineering teammate."}

## Current Runtime Context

- Agent ID: ${agent.id}
- Stable handle: @${agent.handle || agent.name}
- Runtime: ${agent.runtime}
- Model: ${agent.model}
- iTeam server: ${serverUrl}
- Workspace: ${dir}

## Workspace and memory

Your current working directory is your persistent agent workspace. Read and update MEMORY.md for durable context:
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
