// `iteam task ...` — list, create, done (mark complete).

import { printTable, printMessage, printResult } from "../output.js";
import { flagString } from "../args.js";
import type { CommandContext } from "../types.js";
import type { Task } from "@iteam/shared";

export async function runTask(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
      return list(cmd);
    case "create":
      return create(cmd);
    case "done":
    case "complete":
      return done(cmd);
    default:
      throw new Error("usage: iteam task list|create <target> <title...>|done <id>");
  }
}

async function list(cmd: CommandContext): Promise<void> {
  const params = new URLSearchParams();
  const status = flagString(cmd.args, "status");
  const target = flagString(cmd.args, "target");
  const assignee = flagString(cmd.args, "assignee");
  if (status) params.set("status", status);
  if (target) params.set("target", target);
  if (assignee) params.set("assigneeId", assignee);
  const qs = params.toString();
  const tasks = await cmd.client.get<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  printTable(
    tasks.map(t => ({ id: t.id, status: t.status, target: t.target, assignee: t.assigneeId || "", title: t.title })),
    cmd.output
  );
}

async function create(cmd: CommandContext): Promise<void> {
  const target = cmd.args.positionals[0];
  const title = cmd.args.positionals.slice(1).join(" ");
  if (!target || !title) throw new Error("usage: iteam task create <target> <title...> [--agent <agentId>] [--description <text>]");
  const body = {
    target,
    title,
    assigneeId: flagString(cmd.args, "agent"),
    description: flagString(cmd.args, "description")
  };
  const task = await cmd.client.post<Task>("/api/tasks", body);
  printResult(task, cmd.output);
}

async function done(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam task done <id>");
  const task = await cmd.client.patch<Task>(`/api/tasks/${encodeURIComponent(id)}`, { status: "done" });
  printMessage(`task ${id} -> done`, cmd.output, task);
}
