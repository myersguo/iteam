// CLI dispatcher for the `iteam` API-facing commands (auth, space, agent,
// computer, channel, bot, message, task, config). The lifecycle commands
// (server/daemon/web) are handled ahead of this module by bin/iteam.ts, which
// delegates everything else here.

import { parseArgs, flagString } from "./args.js";
import { resolveContext } from "./config.js";
import { ApiClient } from "./client.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { runAuth } from "./commands/auth.js";
import { runSpace } from "./commands/space.js";
import { runAgent } from "./commands/agent.js";
import { runComputer } from "./commands/computer.js";
import { runChannel } from "./commands/channel.js";
import { runBot } from "./commands/bot.js";
import { runMessage } from "./commands/message.js";
import { runTask } from "./commands/task.js";
import { runConfig } from "./commands/config.js";

const HANDLERS: Record<string, CommandHandler> = {
  auth: runAuth,
  space: runSpace,
  agent: runAgent,
  computer: runComputer,
  channel: runChannel,
  bot: runBot,
  message: runMessage,
  task: runTask,
  config: runConfig
};

const GLOBAL_FLAGS = new Set(["server", "space", "token", "json", "yes"]);

export function isCliArea(area: string | undefined): boolean {
  return !!area && area in HANDLERS;
}

export function cliUsage(): string {
  return `iTeam CLI — drive the same operations available in the web UI.

Usage:
  iteam <area> <action> [args] [flags]

Areas:
  auth       login [--provider <id>] [--loopback] | logout | whoami | token <token>
  space      list | create <name> | use <id|slug> | current | delete <id>
  agent      list | create <name> [--share-history] | show <id> | start <id> | stop <id> | set-history <id> on|off | delete <id> | dm <id>
  computer   list | connect-invite | pending | delete <id>
  channel    list | create <name> | show <id> | set-default-agent <id> <agentId> | delete <id>
  bot        lark config --app-id <id> [--app-secret <s>] [--disable] | lark list | list | binding list
  message    send <target> <text...> | read <target> | watch <target>
  task       list | create <target> <title...> | done <id>
  config     list | get <key> | set <key> <value> | use-profile <name> | path

Global flags:
  --server <url>    Override server URL (default: config or http://127.0.0.1:4318)
  --space <id>      Operate within a specific space
  --token <token>   Use a specific session token for this call
  --json            Emit raw JSON instead of tables
  --yes             Skip confirmation for destructive commands

Examples:
  iteam auth login
  iteam space use growth
  iteam message send '#all' "deploy is green"
  iteam agent create reviewer --runtime claude
  iteam --json channel list`;
}

export async function runCli(area: string, action: string | undefined, rest: string[]): Promise<void> {
  const handler = HANDLERS[area];
  if (!handler) {
    console.log(cliUsage());
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(rest);
  const overrides = {
    serverUrl: flagString(args, "server"),
    token: flagString(args, "token"),
    spaceId: flagString(args, "space")
  };
  // Strip global flags so command modules only see their own.
  for (const name of GLOBAL_FLAGS) delete args.flags[name];

  const ctx = resolveContext(overrides);
  const command: CommandContext = {
    client: new ApiClient(ctx),
    ctx,
    args,
    action,
    output: { json: flagBoolFromRaw(rest, "json") },
    overrides,
    assumeYes: flagBoolFromRaw(rest, "yes")
  };

  await handler(command);
}

/**
 * Read a boolean global flag directly from the raw argv slice — the parsed
 * Args has already had globals stripped, and --json/--yes are order-independent.
 */
function flagBoolFromRaw(rest: string[], name: string): boolean {
  return rest.includes(`--${name}`) || rest.includes(`--${name}=true`);
}
