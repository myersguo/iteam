// `iteam computer ...` — list, connect-invite (mint a connect command for a new
// machine), pending (list unclaimed invites), delete.

import { printTable, printMessage, printResult } from "../output.js";
import { flagString } from "../args.js";
import { confirmDestructive } from "../confirm.js";
import type { CommandContext } from "../types.js";
import type { Computer, PendingComputerConnection } from "@iteam/shared";

interface ConnectInviteResult extends PendingComputerConnection {
  command: string;
  serverUrl: string;
}

export async function runComputer(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
      return list(cmd);
    case "connect-invite":
    case "invite":
      return invite(cmd);
    case "pending":
      return pending(cmd);
    case "delete":
    case "rm":
      return remove(cmd);
    default:
      throw new Error("usage: iteam computer list|connect-invite|pending|delete <id>");
  }
}

async function list(cmd: CommandContext): Promise<void> {
  const computers = await cmd.client.get<Computer[]>("/api/computers");
  printTable(
    computers.map(c => ({ id: c.id, name: c.name, status: c.status, agents: c.agentIds.length })),
    cmd.output
  );
}

async function invite(cmd: CommandContext): Promise<void> {
  const body = {
    label: flagString(cmd.args, "label") || "New computer",
    serverUrl: flagString(cmd.args, "server-url")
  };
  const invite = await cmd.client.post<ConnectInviteResult>("/api/computers/connect-command", body);
  if (cmd.output.json) return printResult(invite, cmd.output);
  console.log("Run this on the machine you want to connect:");
  console.log(`  ${invite.command}`);
  console.log(`\ntoken: ${invite.token}`);
  console.log(`space: ${invite.spaceId}`);
}

async function pending(cmd: CommandContext): Promise<void> {
  const rows = await cmd.client.get<PendingComputerConnection[]>("/api/pending-connections");
  printTable(
    rows.map(p => ({ id: p.id, label: p.label, status: p.status, createdAt: p.createdAt })),
    cmd.output
  );
}

async function remove(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam computer delete <id>");
  if (!(await confirmDestructive(cmd, `delete computer ${id}`))) return;
  const result = await cmd.client.delete(`/api/computers/${encodeURIComponent(id)}`);
  printMessage(`deleted computer ${id}`, cmd.output, result);
}
