// `iteam channel ...` — list, create, show, set-default-agent, delete.

import { printTable, printMessage, printResult } from "../output.js";
import { flagString, flagBool } from "../args.js";
import { confirmDestructive } from "../confirm.js";
import type { CommandContext } from "../types.js";
import type { Channel } from "@iteam/shared";

export async function runChannel(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
      return list(cmd);
    case "create":
      return create(cmd);
    case "show":
      return show(cmd);
    case "set-default-agent":
      return setDefaultAgent(cmd);
    case "delete":
    case "rm":
      return remove(cmd);
    default:
      throw new Error("usage: iteam channel list|create <name>|show <id>|set-default-agent <id> <agentId>|delete <id>");
  }
}

async function list(cmd: CommandContext): Promise<void> {
  const channels = await cmd.client.get<Channel[]>("/api/channels");
  printTable(
    channels.map(c => ({ id: c.id, target: c.target, kind: c.kind, members: c.memberIds.length, defaultAgent: c.defaultAgentId || "" })),
    cmd.output
  );
}

async function create(cmd: CommandContext): Promise<void> {
  const name = cmd.args.positionals[0];
  if (!name) throw new Error("usage: iteam channel create <name> [--description <text>] [--private] [--default-agent <id>]");
  const body = {
    name,
    description: flagString(cmd.args, "description"),
    private: flagBool(cmd.args, "private"),
    defaultAgentId: flagString(cmd.args, "default-agent") || null
  };
  const channel = await cmd.client.post<Channel>("/api/channels", body);
  printResult(channel, cmd.output);
}

async function show(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam channel show <id|#target>");
  const channels = await cmd.client.get<Channel[]>("/api/channels");
  const channel = channels.find(c => c.id === id || c.target === id || c.target === `#${id}`);
  if (!channel) throw new Error(`no channel matches "${id}"`);
  printResult(channel, cmd.output);
}

async function setDefaultAgent(cmd: CommandContext): Promise<void> {
  const [id, agentId] = cmd.args.positionals;
  if (!id) throw new Error("usage: iteam channel set-default-agent <id> <agentId|->  (use - to clear)");
  const channels = await cmd.client.get<Channel[]>("/api/channels");
  const channel = channels.find(c => c.id === id || c.target === id || c.target === `#${id}`);
  if (!channel) throw new Error(`no channel matches "${id}"`);
  const value = !agentId || agentId === "-" ? null : agentId;
  const updated = await cmd.client.patch<Channel>(`/api/channels/${encodeURIComponent(channel.id)}`, { defaultAgentId: value });
  printMessage(`default agent for ${updated.target} -> ${value || "(cleared)"}`, cmd.output, updated);
}

async function remove(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam channel delete <id|#target>");
  const channels = await cmd.client.get<Channel[]>("/api/channels");
  const channel = channels.find(c => c.id === id || c.target === id || c.target === `#${id}`);
  if (!channel) throw new Error(`no channel matches "${id}"`);
  if (!(await confirmDestructive(cmd, `delete channel ${channel.target}`))) return;
  const result = await cmd.client.delete(`/api/channels/${encodeURIComponent(channel.id)}`);
  printMessage(`deleted channel ${channel.target}`, cmd.output, result);
}
