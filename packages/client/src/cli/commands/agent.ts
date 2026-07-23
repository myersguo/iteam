// `iteam agent ...` — list, create, show, start, stop, set-history, delete, dm.

import { printTable, printMessage, printResult } from "../output.js";
import { flagString, flagBool } from "../args.js";
import { confirmDestructive } from "../confirm.js";
import type { CommandContext } from "../types.js";
import type { Agent, Channel, Computer } from "@iteam/shared";

export async function runAgent(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
      return list(cmd);
    case "create":
      return create(cmd);
    case "show":
      return show(cmd);
    case "start":
    case "stop":
      return setStatus(cmd, cmd.action);
    case "set-history":
      return setHistory(cmd);
    case "delete":
    case "rm":
      return remove(cmd);
    case "dm":
      return dm(cmd);
    default:
      throw new Error("usage: iteam agent list|create <name>|show <id>|start <id>|stop <id>|set-history <id> on|off|delete <id>|dm <id>");
  }
}

async function list(cmd: CommandContext): Promise<void> {
  const agents = await cmd.client.get<Agent[]>("/api/agents");
  printTable(
    agents.map(a => ({
      id: a.id,
      name: a.name,
      runtime: a.runtime,
      status: a.status,
      model: a.model || "",
      history: a.shareRuntimeHistory ? "shared" : "private"
    })),
    cmd.output
  );
}

async function create(cmd: CommandContext): Promise<void> {
  const name = cmd.args.positionals[0];
  if (!name) throw new Error("usage: iteam agent create <name> [--runtime codex|claude|gemini|trae] [--computer <id>] [--model <model>] [--description <text>] [--share-history]");
  const runtime = flagString(cmd.args, "runtime") || "codex";
  const computerId = await resolveComputerId(cmd, flagString(cmd.args, "computer"));
  const body = {
    name,
    runtime,
    description: flagString(cmd.args, "description") || `${runtime} agent`,
    computerId,
    model: flagString(cmd.args, "model"),
    reasoning: flagString(cmd.args, "reasoning"),
    // Off by default: the runtime's session history stays private so it does
    // not pollute the shared `/resume` picker.
    shareRuntimeHistory: flagBool(cmd.args, "share-history")
  };
  const agent = await cmd.client.post<Agent>("/api/agents", body);
  printResult(agent, cmd.output);
}

/** Toggle whether this agent's runtime turns show up in the shared /resume. */
async function setHistory(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  const value = (cmd.args.positionals[1] || "").toLowerCase();
  if (!id || !["on", "off"].includes(value)) {
    throw new Error("usage: iteam agent set-history <id> on|off  (on = share to /resume, off = private)");
  }
  const share = value === "on";
  const agent = await cmd.client.patch<Agent>(`/api/agents/${encodeURIComponent(id)}`, { shareRuntimeHistory: share });
  printMessage(
    `agent ${id} runtime history -> ${share ? "shared to /resume" : "private"} (restart the agent to apply)`,
    cmd.output,
    agent
  );
}

/**
 * An agent must be pinned to a connected computer. When --computer is omitted
 * we auto-pick the only connected computer; if there are zero or many we ask
 * the user to be explicit instead of failing with a raw "computer not found".
 */
async function resolveComputerId(cmd: CommandContext, explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const computers = await cmd.client.get<Computer[]>("/api/computers");
  if (computers.length === 1) return computers[0].id;
  if (computers.length === 0) {
    throw new Error("no computers connected. Run `iteam computer connect-invite` and connect a daemon first, or pass --computer <id>.");
  }
  throw new Error(`multiple computers connected: ${computers.map(c => c.id).join(", ")}. Pass --computer <id>.`);
}

async function show(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam agent show <id>");
  const agents = await cmd.client.get<Agent[]>("/api/agents");
  const agent = agents.find(a => a.id === id || a.handle === id);
  if (!agent) throw new Error(`no agent matches "${id}"`);
  printResult(agent, cmd.output);
}

async function setStatus(cmd: CommandContext, action: "start" | "stop"): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error(`usage: iteam agent ${action} <id>`);
  const agent = await cmd.client.post<Agent>(`/api/agents/${encodeURIComponent(id)}/${action}`);
  printMessage(`agent ${id} -> ${action}`, cmd.output, agent);
}

async function remove(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam agent delete <id>");
  if (!(await confirmDestructive(cmd, `delete agent ${id}`))) return;
  const result = await cmd.client.delete(`/api/agents/${encodeURIComponent(id)}`);
  printMessage(`deleted agent ${id}`, cmd.output, result);
}

async function dm(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam agent dm <id>");
  const channel = await cmd.client.post<Channel>(`/api/direct-messages/agents/${encodeURIComponent(id)}`);
  printMessage(`DM channel: ${channel.target}`, cmd.output, channel);
}
