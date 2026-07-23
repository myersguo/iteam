// `iteam space ...` — list, create, use (switch active space), current, delete.

import { updateActiveProfile } from "../config.js";
import { printTable, printMessage, printResult } from "../output.js";
import { flagString } from "../args.js";
import { confirmDestructive } from "../confirm.js";
import type { CommandContext } from "../types.js";
import type { Space } from "@iteam/shared";

export async function runSpace(cmd: CommandContext): Promise<void> {
  switch (cmd.action) {
    case "list":
      return list(cmd);
    case "create":
      return create(cmd);
    case "use":
    case "switch":
      return use(cmd);
    case "current":
      return current(cmd);
    case "delete":
    case "rm":
      return remove(cmd);
    default:
      throw new Error("usage: iteam space list|create <name>|use <id|slug>|current|delete <id>");
  }
}

async function list(cmd: CommandContext): Promise<void> {
  const spaces = await cmd.client.get<Space[]>("/api/spaces");
  printTable(
    spaces.map(s => ({ id: s.id, name: s.name, slug: s.slug, active: s.id === cmd.ctx.spaceId ? "*" : "" })),
    cmd.output
  );
}

async function create(cmd: CommandContext): Promise<void> {
  const name = cmd.args.positionals[0];
  if (!name) throw new Error("usage: iteam space create <name> [--slug <slug>] [--description <text>]");
  const body = {
    name,
    slug: flagString(cmd.args, "slug"),
    description: flagString(cmd.args, "description")
  };
  const space = await cmd.client.post<Space>("/api/spaces", body);
  printResult(space, cmd.output);
}

async function use(cmd: CommandContext): Promise<void> {
  const idOrSlug = cmd.args.positionals[0];
  if (!idOrSlug) throw new Error("usage: iteam space use <id|slug>");
  const spaces = await cmd.client.get<Space[]>("/api/spaces");
  const match = spaces.find(s => s.id === idOrSlug || s.slug === idOrSlug);
  if (!match) throw new Error(`no space matches "${idOrSlug}"`);
  updateActiveProfile({ spaceId: match.id });
  printMessage(`active space set to ${match.name} (${match.id})`, cmd.output, { spaceId: match.id });
}

async function current(cmd: CommandContext): Promise<void> {
  if (!cmd.ctx.spaceId) {
    printMessage("no active space set (server default 'space_default' is used)", cmd.output, { spaceId: null });
    return;
  }
  const spaces = await cmd.client.get<Space[]>("/api/spaces").catch(() => [] as Space[]);
  const match = spaces.find(s => s.id === cmd.ctx.spaceId);
  printResult(match || { id: cmd.ctx.spaceId }, cmd.output);
}

async function remove(cmd: CommandContext): Promise<void> {
  const id = cmd.args.positionals[0];
  if (!id) throw new Error("usage: iteam space delete <id>");
  if (id === "space_default") throw new Error("the default space cannot be deleted");
  if (!(await confirmDestructive(cmd, `delete space ${id}`))) return;
  const result = await cmd.client.delete(`/api/spaces/${encodeURIComponent(id)}`);
  printMessage(`deleted space ${id}`, cmd.output, result);
}
